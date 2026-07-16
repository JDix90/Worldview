/**
 * Earthquakes — USGS M2.5+ last 24h, client-direct (CORS-open, keyless;
 * DECISIONS #47). Magnitude-scaled pulsing rings that fade with event age.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { latLngToWorld } from '../globe/surfaceMath';

const FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const REFRESH_MS = 5 * 60_000;
const MAX_EVENTS = 512;
const PICK_RADIUS_PX = 16;
const PULSE_PERIOD_S = 3;

interface Quake {
  id: string;
  mag: number;
  place: string;
  depthKm: number;
  timeMs: number;
  lat: number;
  lon: number;
  url: string;
}

function magScale(mag: number): number {
  return Math.min(10, 0.5 + Math.max(0, mag - 2) ** 2 * 0.35);
}

const vertexShader = /* glsl */ `
  attribute float aAgeH;
  varying vec2 vUv;
  varying float vAgeH;
  void main() {
    vUv = uv;
    vAgeH = aAgeH;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uPhase; // 0..1 pulse phase
  varying vec2 vUv;
  varying float vAgeH;
  void main() {
    float r = length(vUv - 0.5) * 2.0;           // 0 center → 1 rim
    float fade = clamp(1.0 - vAgeH / 24.0, 0.15, 1.0);
    float core = smoothstep(0.25, 0.0, r) * 0.9;  // solid epicenter dot
    float ring = smoothstep(0.09, 0.0, abs(r - uPhase)) * (1.0 - uPhase) * 0.8;
    float a = (core + ring) * fade;
    if (a < 0.02) discard;
    gl_FragColor = vec4(1.0, 0.36, 0.25, a);
  }
`;

export const earthquakesLayer: LayerDef = {
  id: 'quakes',
  label: 'EARTHQUAKES',
  defaultOn: true,
  attribution: 'USGS',
  init(ctx: LayerCtx): LayerInstance {
    const geometry = new THREE.CircleGeometry(1, 24);
    const material = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_EVENTS);
    mesh.frustumCulled = false;
    const ageAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EVENTS), 1);
    geometry.setAttribute('aAgeH', ageAttr);
    ctx.scene.add(mesh);

    let quakes: Quake[] = [];
    const positions = new Float32Array(MAX_EVENTS * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1); // CircleGeometry faces +Z
    const scale = new THREE.Vector3();

    function rebuild(): void {
      const nowMs = Date.now();
      mesh.count = quakes.length;
      quakes.forEach((qk, i) => {
        latLngToWorld(qk.lat, qk.lon, 0.006, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        const normal = pos.clone().normalize();
        q.setFromUnitVectors(up, normal);
        const s = magScale(qk.mag);
        scale.set(s, s, s);
        m.compose(pos, q, scale);
        mesh.setMatrixAt(i, m);
        ageAttr.array[i] = (nowMs - qk.timeMs) / 3600_000;
      });
      mesh.instanceMatrix.needsUpdate = true;
      ageAttr.needsUpdate = true;
    }

    async function refresh(): Promise<void> {
      try {
        const res = await fetch(FEED_URL);
        if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
        const data = (await res.json()) as {
          features: Array<{
            id: string;
            properties: { mag: number | null; place: string | null; time: number; url: string };
            geometry: { coordinates: [number, number, number] };
          }>;
        };
        quakes = data.features
          .filter((f) => typeof f.properties.mag === 'number')
          .slice(0, MAX_EVENTS)
          .map((f) => ({
            id: f.id,
            mag: f.properties.mag!,
            place: f.properties.place ?? 'unknown location',
            depthKm: f.geometry.coordinates[2],
            timeMs: f.properties.time,
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            url: f.properties.url,
          }));
        rebuild();
      } catch (err) {
        console.warn('[quakes] refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      const r2 = 100 * 100;
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < quakes.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < r2) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const qk = quakes[best.i]!;
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: `M${qk.mag.toFixed(1)}`,
            subtitle: 'earthquake',
            rows: [
              { label: 'PLACE', value: qk.place },
              { label: 'DEPTH', value: `${Math.round(qk.depthKm)} km` },
              { label: 'TIME', value: new Date(qk.timeMs).toISOString().slice(5, 16).replace('T', ' ') + 'Z' },
              { label: 'AGE', value: `${((Date.now() - qk.timeMs) / 3600_000).toFixed(1)} h` },
            ],
            href: qk.url,
          }),
      };
    });

    return {
      update(nowMs) {
        material.uniforms.uPhase!.value = (nowMs / 1000 % PULSE_PERIOD_S) / PULSE_PERIOD_S;
      },
      dispose() {
        clearInterval(timer);
        unregister();
        ctx.scene.remove(mesh);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
