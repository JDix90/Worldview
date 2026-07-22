/**
 * Aerosol / smoke — NASA GIBS MODIS Combined Value-Added AOD (aerosol optical
 * depth), the smoke + dust + haze signal. One WMS GetMap request returns a
 * single global colorized PNG (CORS-open, verified 2026-07-16) — no tile
 * stitching. Draped on a low overlay sphere with the aurora layer's
 * uv-from-normal projection; high-AOD plumes light up over the fire fields.
 *
 * AOD lags ~1 day (MODIS is polar-orbiting and processed overnight), so we
 * request yesterday and step back a day if that date isn't ready.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';

const REFRESH_MS = 6 * 3600_000;
/** Near-surface haze: above the globe texture, below aircraft (r≈100.5). */
const OVERLAY_RADIUS = 100.35;
const WMS_BASE = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

function wmsUrl(dateIso: string): string {
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'MODIS_Combined_Value_Added_AOD',
    CRS: 'EPSG:4326',
    BBOX: '-90,-180,90,180',
    WIDTH: '2048',
    HEIGHT: '1024',
    FORMAT: 'image/png',
    TIME: dateIso,
  });
  return `${WMS_BASE}?${q.toString()}`;
}

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// uv-from-normal (same derivation as aurora.ts) so mapping is convention-proof
// against three-globe's geometry rotation. AOD image is north-up; loaded with
// flipY, uv.v=1 → north, matching.
const fragmentShader = /* glsl */ `
  uniform sampler2D aodMap;
  uniform float uOpacity;
  varying vec3 vWorldNormal;

  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = PI * 0.5 - atan(n.z, n.x);
    lng = mod(lng + PI, 2.0 * PI) - PI;
    vec2 uv = vec2((lng + PI) / (2.0 * PI), (lat + PI * 0.5) / PI);

    vec4 aod = texture2D(aodMap, uv);
    // GIBS AOD colormap runs yellow(low) → orange → red(high), so (r − g)
    // orders aerosol magnitude monotonically (yellow g≈0.85 → ~0.15; red
    // g≈0.15 → ~0.85). max(r,g,b) can't tell low-AOD yellow from a plume.
    float mag = clamp((aod.r - aod.g) * 1.25, 0.0, 1.0);
    // suppress the ubiquitous background haze; keep moderate-to-heavy smoke/dust
    float strength = aod.a * smoothstep(0.22, 0.7, mag);
    float a = strength * uOpacity;
    if (a < 0.015) discard;

    // recolor as smoke/haze — a desaturated warm-grey veil thickening to
    // off-white, deliberately NOT amber so it reads as an atmospheric layer
    // rather than competing with the fire/aircraft marks
    vec3 haze = vec3(0.62, 0.58, 0.54);
    vec3 heavy = vec3(0.93, 0.92, 0.9);
    vec3 col = mix(haze, heavy, smoothstep(0.0, 0.8, mag));
    gl_FragColor = vec4(col, a);
  }
`;

export const aerosolLayer: LayerDef = {
  id: 'aerosol',
  label: 'AEROSOL / SMOKE',
  defaultOn: false,
  attribution: 'NASA GIBS',
  init(ctx: LayerCtx): LayerInstance {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        aodMap: { value: new THREE.Texture() },
        uOpacity: { value: 0.62 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(OVERLAY_RADIUS, 96, 48), material);
    mesh.renderOrder = 1; // over the globe surface, before markers
    ctx.scene.add(mesh);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    function isoDaysAgo(n: number): string {
      const d = new Date(Date.now() - n * 86400_000);
      return d.toISOString().slice(0, 10);
    }

    async function refresh(): Promise<void> {
      // yesterday first; step back if that date isn't processed yet
      for (const daysAgo of [1, 2, 3]) {
        try {
          const tex = await loader.loadAsync(wmsUrl(isoDaysAgo(daysAgo)));
          tex.colorSpace = THREE.SRGBColorSpace;
          const prev = material.uniforms.aodMap!.value as THREE.Texture;
          material.uniforms.aodMap!.value = tex;
          prev.dispose();
          return;
        } catch {
          /* try an earlier date */
        }
      }
      console.warn('[aerosol] no AOD image available for the last 3 days');
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    return {
      update(_nowMs, camDist) {
        // The daily AOD grid is coarse (~10px cells at the zoom floor) —
        // fade the veil out as the camera closes in so it never smears the
        // now-sharp surface; full strength by ~2× globe radius out.
        const t = THREE.MathUtils.clamp((camDist - 130) / (210 - 130), 0, 1);
        material.uniforms.uOpacity!.value = 0.62 * t;
      },
      dispose() {
        clearInterval(timer);
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
        (material.uniforms.aodMap!.value as THREE.Texture).dispose();
        material.dispose();
      },
    };
  },
};
