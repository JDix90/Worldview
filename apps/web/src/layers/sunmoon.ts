/**
 * Sun & Moon markers — pure ephemeris, no external source. Glowing discs at
 * the subsolar and sublunar points (the project is called ORRERY, after all).
 * Sun reuses solar.ts; moon uses lunar.ts, with brightness following phase.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { subsolarPoint } from '../globe/solar';
import { sublunarPoint } from '../globe/lunar';
import { latLngToWorld } from '../globe/surfaceMath';

const PICK_RADIUS_PX = 20;
/** Above the aurora shell so the markers never get tinted. */
const MARKER_ALT = 0.045; // r ≈ 104.5
const UPDATE_THROTTLE_MS = 5_000;

function makeGlowMaterial(r: number, g: number, b: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(r, g, b) }, uGain: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uGain;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float core = smoothstep(0.35, 0.05, r);
        float halo = smoothstep(1.0, 0.15, r) * 0.35;
        float a = (core + halo) * uGain;
        if (a < 0.02) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export const sunMoonLayer: LayerDef = {
  id: 'sunmoon',
  label: 'SUN & MOON',
  defaultOn: true,
  attribution: undefined,
  init(ctx: LayerCtx): LayerInstance {
    const sunMat = makeGlowMaterial(1.0, 0.85, 0.45);
    const moonMat = makeGlowMaterial(0.75, 0.8, 0.9);
    const sun = new THREE.Mesh(new THREE.CircleGeometry(3.4, 32), sunMat);
    const moon = new THREE.Mesh(new THREE.CircleGeometry(2.4, 32), moonMat);
    ctx.scene.add(sun, moon);

    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    let lastUpdate = 0;
    let moonInfo = sublunarPoint(new Date());

    function place(): void {
      const now = new Date();
      const s = subsolarPoint(now);
      latLngToWorld(s.lat, s.lng, MARKER_ALT, sun.position);
      q.setFromUnitVectors(up, sun.position.clone().normalize());
      sun.quaternion.copy(q);

      moonInfo = sublunarPoint(now);
      latLngToWorld(moonInfo.lat, moonInfo.lng, MARKER_ALT, moon.position);
      q.setFromUnitVectors(up, moon.position.clone().normalize());
      moon.quaternion.copy(q);
      // a new moon is a dim marker, a full moon bright — honest phase display
      moonMat.uniforms.uGain!.value = 0.35 + 0.65 * moonInfo.illumination;
    }
    place();

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      const candidates: Array<{ d2: number; open: () => void }> = [];
      for (const [mesh, open] of [
        [sun, () => {
          const s = subsolarPoint(new Date());
          ctx.setCard({
            title: 'SUN',
            subtitle: 'subsolar point',
            rows: [
              { label: 'OVERHEAD AT', value: `${s.lat.toFixed(1)}°, ${s.lng.toFixed(1)}°` },
              { label: 'DECLINATION', value: `${s.lat.toFixed(2)}°` },
              { label: 'EQN OF TIME', value: `${s.equationOfTimeMin.toFixed(1)} min` },
            ],
          });
        }],
        [moon, () => {
          ctx.setCard({
            title: 'MOON',
            subtitle: moonInfo.phaseName,
            rows: [
              { label: 'OVERHEAD AT', value: `${moonInfo.lat.toFixed(1)}°, ${moonInfo.lng.toFixed(1)}°` },
              { label: 'ILLUMINATED', value: `${Math.round(moonInfo.illumination * 100)}%` },
              { label: 'DISTANCE', value: `${Math.round(moonInfo.distanceKm).toLocaleString()} km` },
            ],
          });
        }],
      ] as Array<[THREE.Mesh, () => void]>) {
        proj.copy(mesh.position);
        if (proj.dot(camera.position) < 100 * 100) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2) candidates.push({ d2, open });
      }
      candidates.sort((a, b) => a.d2 - b.d2);
      return candidates[0] ?? null;
    });

    return {
      update(nowMs) {
        if (nowMs - lastUpdate > UPDATE_THROTTLE_MS) {
          lastUpdate = nowMs;
          place();
        }
      },
      dispose() {
        unregister();
        ctx.scene.remove(sun, moon);
        sun.geometry.dispose();
        moon.geometry.dispose();
        sunMat.dispose();
        moonMat.dispose();
      },
    };
  },
};
