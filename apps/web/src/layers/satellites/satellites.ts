/**
 * Satellite layer factory (curated set and Starlink shell are two instances
 * of this). TLEs from CelesTrak, SGP4 in a Web Worker at ~1Hz, main thread
 * lerps world positions between worker frames — cartesian lerp, so no
 * longitude-wrap headaches and chord error over 1s is sub-km.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from '../registry';
import { latLngToWorld, GLOBE_RADIUS } from '../../globe/surfaceMath';
import { fetchTles, type Tle } from './tleSource';

const TLE_REFRESH_MS = 6 * 3600_000;
const PICK_RADIUS_PX = 14;
/** CelesTrak group slug → [short label, plain-language note]. */
const GROUP_INFO: Record<string, { label: string; note: string }> = {
  stations: { label: 'Space station', note: 'Crewed orbital station in low Earth orbit.' },
  'gps-ops': { label: 'GPS (US navigation)', note: 'US GPS navigation satellite, ~20,200 km up.' },
  galileo: { label: 'Galileo (EU navigation)', note: 'European navigation satellite.' },
  beidou: { label: 'BeiDou (China navigation)', note: 'Chinese navigation satellite.' },
  'glo-ops': { label: 'GLONASS (Russia navigation)', note: 'Russian navigation satellite.' },
  visual: { label: 'Bright object', note: 'Large enough to see with the naked eye at dusk or dawn.' },
  weather: { label: 'Weather satellite', note: 'Geostationary weather satellite watching one face of Earth.' },
  starlink: { label: 'Starlink', note: 'SpaceX broadband internet satellite in low Earth orbit.' },
};

const EARTH_R_KM = 6371;
/** World units → km, for the speed readout. */
const KM_PER_UNIT = EARTH_R_KM / GLOBE_RADIUS;

export interface SatellitesOptions {
  id: string;
  label: string;
  defaultOn: boolean;
  groups: string[];
  color: number;
  tickMs: number;
  maxInstances: number;
}

export function makeSatellitesLayer(opts: SatellitesOptions): LayerDef {
  return {
    id: opts.id,
    label: opts.label,
    defaultOn: opts.defaultOn,
    attribution: 'CelesTrak',
    init(ctx: LayerCtx): LayerInstance {
      const geometry = new THREE.OctahedronGeometry(0.42);
      const material = new THREE.MeshBasicMaterial({ color: opts.color });
      const mesh = new THREE.InstancedMesh(geometry, material, opts.maxInstances);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      ctx.scene.add(mesh);

      let tles: Tle[] = [];
      let n = 0;
      // worker frames: world positions at tA and tB; render lerps/extrapolates
      let posA: Float32Array | null = null;
      let posB: Float32Array | null = null;
      let altKm: Float32Array | null = null;
      let tA = 0;
      let tB = 0;
      const cur = new Float32Array(opts.maxInstances * 3); // interpolated, for picking
      const idxMap = new Int32Array(opts.maxInstances); // compacted slot → tles index
      const v = new THREE.Vector3();

      const worker = new Worker(new URL('./satWorker.ts', import.meta.url), { type: 'module' });
      worker.onerror = (ev) => console.error(`[satellites:${opts.id}] worker error`, ev.message, ev);
      worker.onmessage = (ev: MessageEvent<{ type: string; t: number; positions: Float32Array }>) => {
        if (ev.data.type !== 'positions') return;
        const geo = ev.data.positions;
        const world = new Float32Array(n * 3);
        const alts = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const lat = geo[i * 3]!;
          if (Number.isNaN(lat)) {
            world[i * 3] = NaN;
            continue;
          }
          const alt = geo[i * 3 + 2]!;
          latLngToWorld(lat, geo[i * 3 + 1]!, alt / EARTH_R_KM, v);
          world[i * 3] = v.x;
          world[i * 3 + 1] = v.y;
          world[i * 3 + 2] = v.z;
          alts[i] = alt;
        }
        posA = posB;
        tA = tB;
        posB = world;
        tB = ev.data.t;
        altKm = alts;
      };

      let disposed = false;
      async function loadTles(): Promise<void> {
        const fetched = await fetchTles(opts.groups);
        if (disposed) return;
        tles = fetched.slice(0, opts.maxInstances);
        n = tles.length;
        posA = posB = null;
        worker.postMessage({
          type: 'init',
          tles: tles.map((t) => ({ l1: t.l1, l2: t.l2 })),
          tickMs: opts.tickMs,
        });
      }
      void loadTles();
      const refreshTimer = setInterval(() => void loadTles(), TLE_REFRESH_MS);

      const matrices = mesh.instanceMatrix.array as Float32Array;
      const proj = new THREE.Vector3();

      const unregister = ctx.registerPicker((px, py, rect, camera) => {
        let best: { d2: number; i: number } | null = null;
        for (let i = 0; i < mesh.count; i++) {
          proj.fromArray(cur, i * 3);
          if (Number.isNaN(proj.x)) continue;
          // silhouette test vs the globe: satellites behind the limb are hidden
          if (proj.dot(camera.position) < GLOBE_RADIUS * GLOBE_RADIUS) continue;
          proj.project(camera);
          const sx = ((proj.x + 1) / 2) * rect.width;
          const sy = ((1 - proj.y) / 2) * rect.height;
          const d2 = (sx - px) ** 2 + (sy - py) ** 2;
          if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
        }
        if (!best) return null;
        const i = idxMap[best.i]!; // compacted render slot → satellite index
        const tle = tles[i]!;
        // speed from the worker frame delta
        let speed = '';
        if (posA && posB && tB > tA) {
          const dx = posB[i * 3]! - posA[i * 3]!;
          const dy = posB[i * 3 + 1]! - posA[i * 3 + 1]!;
          const dz = posB[i * 3 + 2]! - posA[i * 3 + 2]!;
          speed = `${((Math.hypot(dx, dy, dz) * KM_PER_UNIT) / ((tB - tA) / 1000)).toFixed(1)} km/s`;
        }
        const info = GROUP_INFO[tle.group];
        const periodMin = Math.round(tle.periodMin);
        const periodHrs = tle.periodMin / 60;
        const periodStr =
          periodHrs >= 1.5 ? `${periodMin} min (~${periodHrs.toFixed(1)} h per orbit)` : `${periodMin} min per orbit`;
        return {
          d2: best.d2,
          open: () =>
            ctx.setCard({
              title: tle.name,
              subtitle: 'satellite',
              note: info?.note ?? 'Tracked orbital object.',
              rows: [
                { label: 'TYPE', value: info?.label ?? tle.group },
                { label: 'ALTITUDE', value: altKm ? `${Math.round(altKm[i]!).toLocaleString()} km up` : '—' },
                ...(speed ? [{ label: 'SPEED', value: speed }] : []),
                { label: 'ORBIT TIME', value: periodStr },
                ...(Number.isFinite(tle.inclinationDeg)
                  ? [{ label: 'INCLINATION', value: `${tle.inclinationDeg.toFixed(1)}° to the equator` }]
                  : []),
                { label: 'NORAD ID', value: tle.noradId },
              ],
              href: `https://www.n2yo.com/satellite/?s=${tle.noradId}`,
            }),
        };
      });

      return {
        update(nowMs, camDist) {
          if (!posB) return;
          const scale = Math.min(Math.max(camDist / 280, 0.6), 2.4);
          // lerp between worker frames; extrapolate slightly past tB until the next arrives
          const span = posA && tB > tA ? tB - tA : 1;
          const alpha = posA ? Math.min((nowMs - tA) / span, 1.6) : 1;
          let count = 0;
          for (let i = 0; i < n; i++) {
            const bx = posB[i * 3]!;
            if (Number.isNaN(bx)) continue;
            let x = bx;
            let y = posB[i * 3 + 1]!;
            let z = posB[i * 3 + 2]!;
            if (posA && !Number.isNaN(posA[i * 3]!)) {
              const ax = posA[i * 3]!;
              const ay = posA[i * 3 + 1]!;
              const az = posA[i * 3 + 2]!;
              x = ax + (x - ax) * alpha;
              y = ay + (y - ay) * alpha;
              z = az + (z - az) * alpha;
            }
            cur[count * 3] = x;
            cur[count * 3 + 1] = y;
            cur[count * 3 + 2] = z;
            idxMap[count] = i;
            const o = count * 16;
            matrices[o] = scale;      matrices[o + 1] = 0;      matrices[o + 2] = 0;      matrices[o + 3] = 0;
            matrices[o + 4] = 0;      matrices[o + 5] = scale;  matrices[o + 6] = 0;      matrices[o + 7] = 0;
            matrices[o + 8] = 0;      matrices[o + 9] = 0;      matrices[o + 10] = scale; matrices[o + 11] = 0;
            matrices[o + 12] = x;     matrices[o + 13] = y;     matrices[o + 14] = z;     matrices[o + 15] = 1;
            count++;
          }
          mesh.count = count;
          mesh.instanceMatrix.needsUpdate = true;
        },
        dispose() {
          disposed = true;
          clearInterval(refreshTimer);
          worker.terminate();
          unregister();
          ctx.scene.remove(mesh);
          geometry.dispose();
          material.dispose();
        },
      };
    },
  };
}
