/**
 * Rain & storms — GPM IMERG 30-minute precipitation via the GIBS WMS
 * one-image drape pattern (clouds/aerosol siblings). Native radar colors
 * (green→yellow→red rain, blue frozen) at moderate opacity — the universal
 * weather-app idiom beats palette purity for a living-room instrument.
 *
 * Source truth (spiked 2026-07-21): the layer id must be
 * IMERG_Precipitation_Rate_30min (PT30M, ~4–8 h latency). The similarly-named
 * IMERG_Precipitation_Rate is a *daily* product whose TIME format silently
 * mismatches half-hourly timestamps — renders transparent (DECISIONS #106).
 * Empty timestamps return ~2 KB fully-transparent PNGs, so availability is
 * probed by stepping back in 30-min increments and checking blob size.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';

const REFRESH_MS = 30 * 60_000;
const OVERLAY_RADIUS = 100.335; // above clouds (100.32), below aerosol (100.35)
const BASE_OPACITY = 0.8;
const PROBE_START_MIN = 4 * 60; // IMERG early-run latency
const PROBE_MAX_TRIES = 20;

/**
 * Unpublished timestamps return fully-transparent PNGs whose byte size varies
 * with dimensions (a 2048×1024 empty is ~8 KB — a byte threshold is a trap,
 * found the hard way). Decode a thumbnail and count real alpha instead.
 */
async function hasContent(bmp: ImageBitmap): Promise<boolean> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const c2d = canvas.getContext('2d')!;
  c2d.drawImage(bmp, 0, 0, 64, 32);
  const px = c2d.getImageData(0, 0, 64, 32).data;
  let filled = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i]! > 16) filled++;
  return filled > 10; // >0.5% of the thumbnail has actual precip
}

const WMS_BASE = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

function wmsUrl(timeIso: string): string {
  const p = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'IMERG_Precipitation_Rate_30min',
    CRS: 'EPSG:4326',
    BBOX: '-90,-180,90,180',
    WIDTH: '2048',
    HEIGHT: '1024',
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    TIME: timeIso,
  });
  return `${WMS_BASE}?${p.toString()}`;
}

/** Round down to a 30-min boundary, minus `minutesBack`. */
function slotIso(minutesBack: number): string {
  const t = new Date(Date.now() - minutesBack * 60_000);
  t.setUTCMinutes(t.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return t.toISOString().slice(0, 19) + 'Z';
}

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D rainMap;
  uniform float uOpacity;
  varying vec3 vWorldNormal;
  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = PI * 0.5 - atan(n.z, n.x);
    lng = mod(lng + PI, 2.0 * PI) - PI;
    vec2 uv = vec2((lng + PI) / (2.0 * PI), (lat + PI * 0.5) / PI);

    vec4 c = texture2D(rainMap, uv);
    float a = c.a * uOpacity;
    if (a < 0.02) discard;
    gl_FragColor = vec4(c.rgb, a);
  }
`;

export const rainLayer: LayerDef = {
  id: 'rain',
  label: 'RAIN & STORMS',
  defaultOn: true,
  attribution: 'NASA GIBS',
  init(ctx: LayerCtx): LayerInstance {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        rainMap: { value: new THREE.Texture() },
        uOpacity: { value: BASE_OPACITY },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(OVERLAY_RADIUS, 96, 48), material);
    mesh.renderOrder = 1;
    mesh.visible = false; // until real imagery lands
    ctx.scene.add(mesh);

    let lastGoodSlotMin: number | null = null; // minutesBack of the last hit

    async function loadSlot(minutesBack: number): Promise<boolean> {
      try {
        const res = await fetch(wmsUrl(slotIso(minutesBack)));
        if (!res.ok) return false;
        const blob = await res.blob();
        // ImageBitmap bypasses three's texture.flipY — orient at decode time
        const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
        if (!(await hasContent(bmp))) return false; // not yet published
        const tex = new THREE.Texture(bmp);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        const prev = material.uniforms.rainMap!.value as THREE.Texture;
        material.uniforms.rainMap!.value = tex;
        prev.dispose();
        mesh.visible = true;
        return true;
      } catch {
        return false;
      }
    }

    async function refresh(): Promise<void> {
      // start near the last-known-good slot (or the typical latency edge) and
      // walk back until imagery appears
      const startMin = lastGoodSlotMin !== null ? Math.max(30, lastGoodSlotMin - 60) : PROBE_START_MIN;
      for (let i = 0; i < PROBE_MAX_TRIES; i++) {
        const minutesBack = startMin + i * 30;
        if (await loadSlot(minutesBack)) {
          lastGoodSlotMin = minutesBack;
          return;
        }
      }
      console.warn('[rain] no IMERG imagery found in the probe window');
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    return {
      update(_nowMs, camDist) {
        // fade out up close — 2K blobby data isn't meant for country-level zoom
        const t = Math.min(Math.max((camDist - 140) / (240 - 140), 0), 1);
        material.uniforms.uOpacity!.value = BASE_OPACITY * t;
      },
      dispose() {
        clearInterval(timer);
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
        material.dispose();
        (material.uniforms.rainMap!.value as THREE.Texture).dispose();
      },
    };
  },
};
