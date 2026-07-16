/**
 * Wind particles — nullschool-style flowing streamlines advected through the
 * Open-Meteo 10m field (windField.ts). Each particle carries a short world-
 * space trail rendered as additive line segments, bright at the head and
 * fading to the tail, colored deep-cyan → white by wind speed. Particles
 * respawn on age, at the poles, or in dead-calm cells.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from '../registry';
import { latLngToWorld } from '../../globe/surfaceMath';
import { fetchWindField, sampleUV, LAT_MIN, type WindField } from './windField';

const N = 6000;
const TRAIL_LEN = 14;                // world points per particle → flowing streamlines
const SEGS = TRAIL_LEN - 1;          // line segments per particle
const VERTS = SEGS * 2;              // duplicated endpoints for LineSegments
const RADIUS = 100.45;               // below aircraft (base clearance ~100.5)
const REFRESH_MS = 6 * 3600_000;
const SPEED = 0.55;                  // deg travelled per (m/s) per second (visual)
const MAX_SPEED = 25;                // m/s → white; scales the color ramp
const LIFE_MIN = 3.0;
const LIFE_MAX = 8.0;
const DEG = Math.PI / 180;

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

const vertexShader = /* glsl */ `
  attribute float aAlpha;   // trail fade, fixed per vertex slot
  attribute float aSpeed;   // 0..1 normalized wind speed, per particle
  varying float vAlpha;
  varying float vSpeed;
  void main() {
    vAlpha = aAlpha;
    vSpeed = aSpeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  varying float vSpeed;
  void main() {
    if (vAlpha < 0.01) discard;
    vec3 slow = vec3(0.25, 0.7, 1.0);   // deep cyan
    vec3 fast = vec3(0.9, 0.98, 1.0);   // near white
    vec3 col = mix(slow, fast, vSpeed);
    gl_FragColor = vec4(col, vAlpha * 0.75);
  }
`;

export const windLayer: LayerDef = {
  id: 'wind',
  label: 'WIND',
  defaultOn: true,
  attribution: 'Open-Meteo / GFS',
  init(ctx: LayerCtx): LayerInstance {
    // per-particle state
    const lat = new Float32Array(N);
    const lon = new Float32Array(N);
    const age = new Float32Array(N);
    const life = new Float32Array(N);
    const spd = new Float32Array(N); // normalized speed for color
    // trail ring: TRAIL_LEN world points per particle, index 0 = head (newest)
    const trail = new Float32Array(N * TRAIL_LEN * 3);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(N * VERTS * 3);
    const alphaAttr = new Float32Array(N * VERTS);
    const speedAttr = new Float32Array(N * VERTS);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphaAttr, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speedAttr, 1).setUsage(THREE.DynamicDrawUsage));
    // aAlpha is fixed: segment s (verts 2s, 2s+1) fades with trail age
    for (let p = 0; p < N; p++) {
      for (let s = 0; s < SEGS; s++) {
        const a = 1 - s / SEGS; // head bright → tail faint
        alphaAttr[p * VERTS + s * 2] = a;
        alphaAttr[p * VERTS + s * 2 + 1] = a;
      }
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.visible = false; // until the field loads
    ctx.scene.add(lines);

    let field: WindField | null = null;
    const uv: [number, number] = [0, 0];
    const world = new THREE.Vector3();

    function spawn(p: number): void {
      lat[p] = rand(LAT_MIN + 2, -LAT_MIN - 2);
      lon[p] = rand(-180, 180);
      age[p] = 0;
      life[p] = rand(LIFE_MIN, LIFE_MAX);
      latLngToWorld(lat[p]!, lon[p]!, (RADIUS - 100) / 100, world);
      // collapse the whole trail onto the spawn point (no streak from nowhere)
      for (let i = 0; i < TRAIL_LEN; i++) {
        trail[(p * TRAIL_LEN + i) * 3] = world.x;
        trail[(p * TRAIL_LEN + i) * 3 + 1] = world.y;
        trail[(p * TRAIL_LEN + i) * 3 + 2] = world.z;
      }
    }
    for (let p = 0; p < N; p++) spawn(p);

    async function refresh(): Promise<void> {
      try {
        field = await fetchWindField();
        lines.visible = true;
      } catch (err) {
        console.warn('[wind] field fetch failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    let lastMs = 0;
    return {
      update(nowMs) {
        if (!field) return;
        const dt = lastMs > 0 ? Math.min((nowMs - lastMs) / 1000, 0.05) : 0.016;
        lastMs = nowMs;

        for (let p = 0; p < N; p++) {
          age[p] = age[p]! + dt;
          const speed = sampleUV(field, lat[p]!, lon[p]!, uv);
          // respawn conditions: too old, wandered off-grid, or dead calm
          if (age[p]! > life[p]! || Math.abs(lat[p]!) > -LAT_MIN - 1 || speed < 0.15) {
            spawn(p);
            continue;
          }
          // advect (east/north m/s → deg/s; lon scaled by latitude)
          const cosLat = Math.max(Math.cos(lat[p]! * DEG), 0.1);
          lat[p] = lat[p]! + uv[1] * SPEED * dt;
          lon[p] = lon[p]! + (uv[0] * SPEED * dt) / cosLat;
          spd[p] = Math.min(speed / MAX_SPEED, 1);

          // push new head into the trail ring (shift back, write index 0)
          const base = p * TRAIL_LEN * 3;
          for (let i = TRAIL_LEN - 1; i > 0; i--) {
            trail[base + i * 3] = trail[base + (i - 1) * 3]!;
            trail[base + i * 3 + 1] = trail[base + (i - 1) * 3 + 1]!;
            trail[base + i * 3 + 2] = trail[base + (i - 1) * 3 + 2]!;
          }
          latLngToWorld(lat[p]!, lon[p]!, (RADIUS - 100) / 100, world);
          trail[base] = world.x;
          trail[base + 1] = world.y;
          trail[base + 2] = world.z;
        }

        // rebuild line + speed buffers from the trails
        for (let p = 0; p < N; p++) {
          const tb = p * TRAIL_LEN * 3;
          const vb = p * VERTS * 3;
          const sb = p * VERTS;
          const s = spd[p]!;
          for (let seg = 0; seg < SEGS; seg++) {
            const a = tb + seg * 3;         // trail point seg
            const b = tb + (seg + 1) * 3;   // trail point seg+1
            const o = vb + seg * 6;
            positions[o] = trail[a]!;     positions[o + 1] = trail[a + 1]!; positions[o + 2] = trail[a + 2]!;
            positions[o + 3] = trail[b]!; positions[o + 4] = trail[b + 1]!; positions[o + 5] = trail[b + 2]!;
            speedAttr[sb + seg * 2] = s;
            speedAttr[sb + seg * 2 + 1] = s;
          }
        }
        geometry.attributes.position!.needsUpdate = true;
        geometry.attributes.aSpeed!.needsUpdate = true;
      },
      dispose() {
        clearInterval(timer);
        ctx.scene.remove(lines);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
