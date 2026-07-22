/**
 * Ocean-current particles — the wind layer's trail renderer tuned for the
 * sea: fewer, slower particles with longer trails in a deep-teal→aqua
 * palette (wind is cyan→white, at a higher shell). Real currents are ~50×
 * slower than wind, so the visual advection constant is higher — structure
 * stays honest (Gulf Stream races, gyre interiors crawl), absolute speed is
 * exaggerated for legibility. Land = null in the field = dead water →
 * particles respawn out of it.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from '../registry';
import { latLngToWorld } from '../../globe/surfaceMath';
import { fetchOceanField, sampleUV, LAT_MIN, type OceanField } from './oceanField';

const N = 4000;
const TRAIL_LEN = 16;
const SEGS = TRAIL_LEN - 1;
const VERTS = SEGS * 2;
const RADIUS = 100.3;
const REFRESH_MS = 6 * 3600_000;
const SPEED = 4.0;              // deg per (m/s) per second — currents are slow
// normalize color to TYPICAL currents, not the Gulf Stream core — with max at
// 1.8 m/s the whole open ocean sat at the dark end of the ramp (invisible)
const MAX_SPEED = 0.7;          // m/s → full aqua; boundary currents saturate
const DEAD_WATER = 0.02;        // m/s — below this (incl. land nulls) respawn
const LIFE_MIN = 4.0;
const LIFE_MAX = 10.0;
const DEG = Math.PI / 180;

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSpeed;
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
    vec3 slow = vec3(0.12, 0.55, 0.52);  // teal
    vec3 fast = vec3(0.55, 1.0, 0.92);   // bright aqua
    vec3 col = mix(slow, fast, vSpeed);
    gl_FragColor = vec4(col, vAlpha * 0.9);
  }
`;

export const currentsLayer: LayerDef = {
  id: 'currents',
  label: 'OCEAN CURRENTS',
  defaultOn: false,
  attribution: 'Open-Meteo Marine',
  init(ctx: LayerCtx): LayerInstance {
    const lat = new Float32Array(N);
    const lon = new Float32Array(N);
    const age = new Float32Array(N);
    const life = new Float32Array(N);
    const spd = new Float32Array(N);
    const trail = new Float32Array(N * TRAIL_LEN * 3);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(N * VERTS * 3);
    const alphaAttr = new Float32Array(N * VERTS);
    const speedAttr = new Float32Array(N * VERTS);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphaAttr, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speedAttr, 1).setUsage(THREE.DynamicDrawUsage));
    for (let p = 0; p < N; p++) {
      for (let s = 0; s < SEGS; s++) {
        const a = 1 - s / SEGS;
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
    lines.visible = false;
    ctx.scene.add(lines);

    let field: OceanField | null = null;
    const uv: [number, number] = [0, 0];
    const world = new THREE.Vector3();

    function spawn(p: number): void {
      // bias respawns into live water: take the best of a few tries
      let bLat = 0, bLon = 0, bSpeed = -1;
      for (let tries = 0; tries < 4; tries++) {
        const la = rand(LAT_MIN + 2, -LAT_MIN - 2);
        const lo = rand(-180, 180);
        const s = field ? sampleUV(field, la, lo, uv) : 0;
        if (s > bSpeed) {
          bSpeed = s;
          bLat = la;
          bLon = lo;
        }
        if (s > DEAD_WATER * 3) break;
      }
      lat[p] = bLat;
      lon[p] = bLon;
      age[p] = 0;
      life[p] = rand(LIFE_MIN, LIFE_MAX);
      latLngToWorld(bLat, bLon, (RADIUS - 100) / 100, world);
      for (let i = 0; i < TRAIL_LEN; i++) {
        trail[(p * TRAIL_LEN + i) * 3] = world.x;
        trail[(p * TRAIL_LEN + i) * 3 + 1] = world.y;
        trail[(p * TRAIL_LEN + i) * 3 + 2] = world.z;
      }
    }
    for (let p = 0; p < N; p++) spawn(p);

    async function refresh(): Promise<void> {
      try {
        field = await fetchOceanField();
        for (let p = 0; p < N; p++) spawn(p); // reseed into live water
        lines.visible = true;
      } catch (err) {
        console.warn('[currents] field fetch failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    let lastMs = 0;
    let lastShiftMs = 0;
    return {
      update(nowMs) {
        if (!field) return;
        const dt = lastMs > 0 ? Math.min((nowMs - lastMs) / 1000, 0.05) : 0.016;
        lastMs = nowMs;
        // Trail points are committed on a fixed cadence, not per frame:
        // currents advance ~0.8°/s, so per-frame spacing makes a 16-point
        // trail span <10px (invisible — the wind layer's lesson, worse).
        // At 140ms/point the trail spans ~2° of drift: a real streamline.
        const shift = nowMs - lastShiftMs >= 140;
        if (shift) lastShiftMs = nowMs;

        for (let p = 0; p < N; p++) {
          age[p] = age[p]! + dt;
          const speed = sampleUV(field, lat[p]!, lon[p]!, uv);
          if (age[p]! > life[p]! || Math.abs(lat[p]!) > -LAT_MIN - 1 || speed < DEAD_WATER) {
            spawn(p);
            continue;
          }
          const cosLat = Math.max(Math.cos(lat[p]! * DEG), 0.1);
          lat[p] = lat[p]! + uv[1] * SPEED * dt;
          lon[p] = lon[p]! + (uv[0] * SPEED * dt) / cosLat;
          spd[p] = Math.min(speed / MAX_SPEED, 1);

          const base = p * TRAIL_LEN * 3;
          if (shift) {
            for (let i = TRAIL_LEN - 1; i > 0; i--) {
              trail[base + i * 3] = trail[base + (i - 1) * 3]!;
              trail[base + i * 3 + 1] = trail[base + (i - 1) * 3 + 1]!;
              trail[base + i * 3 + 2] = trail[base + (i - 1) * 3 + 2]!;
            }
          }
          // head always tracks the live position (stretches until committed)
          latLngToWorld(lat[p]!, lon[p]!, (RADIUS - 100) / 100, world);
          trail[base] = world.x;
          trail[base + 1] = world.y;
          trail[base + 2] = world.z;
        }

        for (let p = 0; p < N; p++) {
          const tb = p * TRAIL_LEN * 3;
          const vb = p * VERTS * 3;
          const sb = p * VERTS;
          const s = spd[p]!;
          for (let seg = 0; seg < SEGS; seg++) {
            const a = tb + seg * 3;
            const b = tb + (seg + 1) * 3;
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
