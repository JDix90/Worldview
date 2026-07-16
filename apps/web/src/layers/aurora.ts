/**
 * Aurora — NOAA SWPC OVATION 30-min forecast, client-direct. The probability
 * grid is drawn into a canvas texture and blended additively onto an overlay
 * sphere, masked to the night side using the SAME sun direction the
 * terminator uses — the glow lives only where it would actually be seen.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';

const FEED_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const REFRESH_MS = 30 * 60_000;
/** Aurora emission altitude ~100-300km → hover above aircraft, below LEO. */
const OVERLAY_RADIUS = 103;

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec2 vUv;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// uv is computed from the world normal (not the sphere's built-in uv) so the
// texture mapping is convention-proof against three-globe's geometry rotation
const fragmentShader = /* glsl */ `
  uniform sampler2D auroraMap;
  uniform vec3 sunDir;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  const float PI = 3.141592653589793;

  void main() {
    vec3 n = normalize(vWorldNormal);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float lng = PI * 0.5 - atan(n.z, n.x);
    lng = mod(lng + PI, 2.0 * PI) - PI;
    vec2 uv = vec2((lng + PI) / (2.0 * PI), (lat + PI * 0.5) / PI);

    float p = texture2D(auroraMap, uv).r;      // probability 0..1
    float night = smoothstep(0.15, -0.1, dot(n, sunDir));
    float a = p * night;
    if (a < 0.01) discard;

    // green core shading into violet at the faint edges
    vec3 green = vec3(0.25, 1.0, 0.55);
    vec3 violet = vec3(0.55, 0.3, 0.9);
    vec3 col = mix(violet, green, smoothstep(0.1, 0.7, p));
    gl_FragColor = vec4(col * a * 0.85, a * 0.7);
  }
`;

export const auroraLayer: LayerDef = {
  id: 'aurora',
  label: 'AURORA',
  defaultOn: true,
  attribution: 'NOAA SWPC',
  init(ctx: LayerCtx): LayerInstance {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 181;
    const canvasCtx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        auroraMap: { value: texture },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(OVERLAY_RADIUS, 96, 48), material);
    mesh.renderOrder = 2;
    ctx.scene.add(mesh);

    async function refresh(): Promise<void> {
      try {
        const res = await fetch(FEED_URL);
        if (!res.ok) throw new Error(`SWPC HTTP ${res.status}`);
        const data = (await res.json()) as { coordinates: Array<[number, number, number]> };
        const img = canvasCtx.createImageData(360, 181);
        for (const [lon, lat, prob] of data.coordinates) {
          // grid: lon 0..359 (east), lat -90..90. Canvas row 0 is the TOP of
          // the texture (flipY), so y = 90 − lat puts +90° on row 0.
          const x = Math.round((lon + 180) % 360);
          const y = Math.round(90 - lat);
          if (x < 0 || x > 359 || y < 0 || y > 180) continue;
          const o = (y * 360 + x) * 4;
          const v = Math.min(255, Math.round((prob / 100) * 255 * 2.2)); // gain: probabilities are conservative
          img.data[o] = v;
          img.data[o + 1] = v;
          img.data[o + 2] = v;
          img.data[o + 3] = 255;
        }
        canvasCtx.putImageData(img, 0, 0);
        texture.needsUpdate = true;
      } catch (err) {
        console.warn('[aurora] refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    return {
      update() {
        (material.uniforms.sunDir!.value as THREE.Vector3).copy(ctx.getSunDir());
      },
      dispose() {
        clearInterval(timer);
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
        material.dispose();
        texture.dispose();
      },
    };
  },
};
