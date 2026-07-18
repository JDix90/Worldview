/**
 * Live cloud cover — NASA GIBS MODIS Terra true-color, draped as a
 * clouds-only veil. Same one-image WMS pattern as aerosol.ts.
 *
 * Two hard-won corrections over a naive true-color drape (adversarial review):
 * 1. The imagery is a sunlit daytime swath mosaic — draped raw it would show
 *    sunlit clouds on the globe's night side. The fragment fades the veil
 *    across the real terminator using the shared sun direction.
 * 2. Draping full imagery would *replace* the sharp 8K base texture with
 *    blurry daily pixels. Instead we key out everything but cloud: bright AND
 *    desaturated pixels pass (clouds are white-grey); dark ocean and saturated
 *    land are discarded. Snow false-positives at high latitudes — accepted.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';

const REFRESH_MS = 3 * 3600_000; // swaths accumulate through the day
const OVERLAY_RADIUS = 100.32; // below aerosol (100.35): smoke reads over cloud
const BASE_OPACITY = 0.85;

const WMS_BASE = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

function wmsUrl(dateIso: string): string {
  const p = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    CRS: 'EPSG:4326',
    BBOX: '-90,-180,90,180',
    WIDTH: '4096',
    HEIGHT: '2048',
    // JPEG: half the bytes of PNG; no-data arrives black, which the luma key
    // discards anyway
    FORMAT: 'image/jpeg',
    TIME: dateIso,
  });
  return `${WMS_BASE}?${p.toString()}`;
}

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D cloudMap;
  uniform float uOpacity;
  uniform vec3 uSunDir;
  varying vec3 vWorldNormal;
  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = PI * 0.5 - atan(n.z, n.x);
    lng = mod(lng + PI, 2.0 * PI) - PI;
    vec2 uv = vec2((lng + PI) / (2.0 * PI), (lat + PI * 0.5) / PI);

    vec3 c = texture2D(cloudMap, uv).rgb;

    // cloud key: bright AND desaturated. Ocean is dark (low luma); land is
    // mid-luma but saturated (green/tan); cloud is high-luma grey-white.
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx > 0.001 ? (mx - mn) / mx : 0.0;
    float cloudiness = smoothstep(0.35, 0.72, luma) * (1.0 - smoothstep(0.18, 0.38, sat));

    // fade across the real terminator: the imagery is all-daytime, so clouds
    // must not glow over the night side's city lights
    float ndotl = dot(n, normalize(uSunDir));
    float dayFactor = smoothstep(-0.08, 0.18, ndotl);

    float a = cloudiness * dayFactor * uOpacity;
    if (a < 0.02) discard;
    // white veil, faint luma shading so thick decks read denser
    vec3 col = vec3(0.93, 0.95, 0.99) * (0.82 + 0.18 * luma);
    gl_FragColor = vec4(col, a);
  }
`;

export const cloudsLayer: LayerDef = {
  id: 'clouds',
  label: 'CLOUDS',
  defaultOn: true,
  attribution: 'NASA GIBS',
  init(ctx: LayerCtx): LayerInstance {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        cloudMap: { value: new THREE.Texture() },
        uOpacity: { value: BASE_OPACITY },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(OVERLAY_RADIUS, 96, 48), material);
    mesh.renderOrder = 1;
    ctx.scene.add(mesh);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    function isoDaysAgo(n: number): string {
      return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    }

    async function refresh(): Promise<void> {
      // yesterday first: today's mosaic is still filling and its live swath
      // edge renders as a hard seam + brown low-sun band at the terminator
      // (seen in verification). A complete mosaic beats a few hours' currency.
      for (const daysAgo of [1, 2, 3]) {
        try {
          const tex = await loader.loadAsync(wmsUrl(isoDaysAgo(daysAgo)));
          tex.colorSpace = THREE.SRGBColorSpace;
          const prev = material.uniforms.cloudMap!.value as THREE.Texture;
          material.uniforms.cloudMap!.value = tex;
          prev.dispose();
          return;
        } catch {
          /* try the previous day */
        }
      }
      console.warn('[clouds] no GIBS true-color imagery for the last 3 days');
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    return {
      update(_nowMs, camDist) {
        (material.uniforms.uSunDir!.value as THREE.Vector3).copy(ctx.getSunDir());
        // fade out as the camera closes in — 4K daily pixels get blurry up close
        const t = Math.min(Math.max((camDist - 135) / (230 - 135), 0), 1);
        material.uniforms.uOpacity!.value = BASE_OPACITY * t;
      },
      dispose() {
        clearInterval(timer);
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
        material.dispose();
        (material.uniforms.cloudMap!.value as THREE.Texture).dispose();
      },
    };
  },
};
