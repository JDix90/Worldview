/**
 * Live vessels — global AIS via aisstream.io (free key in .env as
 * AISSTREAM_KEY; the layer idles with a console warn when unset). The
 * WebSocket firehose lives in ais.worker.ts; this side renders 1Hz
 * snapshots as flat elongated diamonds lying on the sea (writeHeadingMatrix
 * basis: Y = surface normal, Z = course), colored by AIS ship-type bucket.
 * Ships are slow — snapping to 1Hz fixes needs no interpolation.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from '../registry';
import { latLngToWorld, writeHeadingMatrix } from '../../globe/surfaceMath';
import { agoShort, compass16, ktMph } from '../../format';

const MAX_INSTANCES = 20_000;
const SEA_ALT = 0.0018; // r≈100.18 — above lanes' visual band start, below aircraft
const PICK_RADIUS_PX = 16;
const SCALE_DIST_REF = 300;
const SCALE_MIN = 0.35;
const SCALE_MAX = 1.4;

/** AIS ship-type code → bucket + color + words. */
function bucket(type: number): { idx: number; words: string } {
  if (type >= 70 && type <= 79) return { idx: 0, words: 'Cargo vessel' };
  if (type >= 80 && type <= 89) return { idx: 1, words: 'Tanker' };
  if ((type >= 60 && type <= 69) || type === 36 || type === 37) return { idx: 2, words: 'Passenger / pleasure craft' };
  if (type === 30) return { idx: 3, words: 'Fishing vessel' };
  return { idx: 4, words: 'Vessel' };
}
const BUCKET_COLORS = [
  new THREE.Color(0x7fc4ff), // cargo — steel blue
  new THREE.Color(0xffa04d), // tanker — orange
  new THREE.Color(0xd48fff), // passenger — violet
  new THREE.Color(0x67e8c8), // fishing — sea green
  new THREE.Color(0xc0cede), // other — grey
];

interface WorkerVessel {
  lat: number;
  lon: number;
  sogKt: number;
  cogDeg: number;
  name: string | null;
  type: number;
  destination: string | null;
  seenAt: number;
}

export const vesselsLayer: LayerDef = {
  id: 'ships',
  label: 'VESSELS',
  defaultOn: true,
  attribution: 'aisstream.io',
  init(ctx: LayerCtx): LayerInstance {
    if (!__AISSTREAM_KEY__) {
      console.warn('[vessels] AISSTREAM_KEY not set — layer idle (free key: https://aisstream.io)');
      return { dispose() {} };
    }

    // flat diamond on the sea surface: XZ plane (faces +Y normal), bow +Z
    const geometry = new THREE.CircleGeometry(1, 4);
    geometry.rotateX(-Math.PI / 2);
    geometry.scale(0.42, 1, 1.15);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    ctx.scene.add(mesh);

    // latest snapshot (kept for picking + re-pack on camera move)
    let snapN = 0;
    let snapF: Float32Array<ArrayBufferLike> = new Float32Array(0);
    let snapM: Float64Array<ArrayBufferLike> = new Float64Array(0);
    let snapT: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const positions = new Float32Array(MAX_INSTANCES * 3);
    const pos = new THREE.Vector3();
    const proj = new THREE.Vector3();
    let lastPackedScale = -1;
    let dirty = false;

    const worker = new Worker(new URL('./ais.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (ev) => console.error('[vessels] worker error', ev.message ?? ev);
    let pendingCard: number | null = null;
    worker.onmessage = (ev: MessageEvent<Record<string, unknown>>) => {
      const msg = ev.data;
      if (msg.kind === 'snapshot') {
        snapN = msg.n as number;
        snapF = msg.f as Float32Array;
        snapM = msg.mmsis as Float64Array;
        snapT = msg.types as Uint8Array;
        dirty = true;
      } else if (msg.kind === 'stats') {
        // visible in devtools; the message-rate number for the perf ledger
        console.debug('[vessels]', msg.msgPerSec, 'msg/s ·', msg.tracked, 'tracked ·', msg.unknownCount, 'unknown');
      } else if (msg.kind === 'diagnostic') {
        console.warn('[vessels] unrecognized envelope sample:', msg.sample);
      } else if (msg.kind === 'detail' && pendingCard === msg.mmsi) {
        pendingCard = null;
        openCard(msg.mmsi as number, msg.vessel as WorkerVessel | null);
      }
    };
    worker.postMessage({ kind: 'start', apiKey: __AISSTREAM_KEY__ });

    function openCard(mmsi: number, v: WorkerVessel | null): void {
      if (!v) return;
      const b = bucket(v.type);
      const dest = v.destination && v.destination.length > 1 ? v.destination : null;
      ctx.setCard({
        title: v.name ?? `MMSI ${mmsi}`,
        subtitle: 'vessel',
        note: dest ? `${b.words} — bound for ${dest}.` : `${b.words} — destination not broadcast.`,
        rows: [
          { label: 'TYPE', value: b.words + (v.type ? ` (AIS ${v.type})` : '') },
          { label: 'SPEED', value: v.sogKt > 0.2 ? ktMph(v.sogKt) : 'stationary' },
          ...(v.sogKt > 0.2
            ? [{ label: 'COURSE', value: `${Math.round(v.cogDeg)}° ${compass16(v.cogDeg)}` }]
            : []),
          ...(dest ? [{ label: 'DESTINATION', value: dest }] : []),
          { label: 'MMSI', value: String(mmsi) },
          { label: 'SEEN', value: agoShort(v.seenAt) },
        ],
        href: `https://www.vesselfinder.com/vessels/details/${mmsi}`,
      });
    }

    function pack(camDist: number): void {
      const s = Math.min(Math.max(camDist / SCALE_DIST_REF, SCALE_MIN), SCALE_MAX);
      const n = Math.min(snapN, MAX_INSTANCES);
      const matrices = mesh.instanceMatrix.array as Float32Array;
      const colors = mesh.instanceColor!.array as Float32Array;
      for (let i = 0; i < n; i++) {
        latLngToWorld(snapF[i * 4]!, snapF[i * 4 + 1]!, SEA_ALT, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        writeHeadingMatrix(matrices, i, pos, snapF[i * 4 + 3]!, s);
        const c = BUCKET_COLORS[bucket(snapT[i]!).idx]!;
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      lastPackedScale = s;
    }

    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      const r2 = 100 * 100;
      let best: { d2: number; i: number } | null = null;
      const n = Math.min(snapN, MAX_INSTANCES);
      for (let i = 0; i < n; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < r2) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const mmsi = snapM[best.i]!;
      return {
        d2: best.d2,
        open: () => {
          pendingCard = mmsi;
          worker.postMessage({ kind: 'detail', mmsi });
        },
      };
    });

    return {
      update(_nowMs, camDist) {
        const s = Math.min(Math.max(camDist / SCALE_DIST_REF, SCALE_MIN), SCALE_MAX);
        if (dirty || Math.abs(s - lastPackedScale) > 0.02) {
          dirty = false;
          pack(camDist);
        }
      },
      dispose() {
        worker.terminate();
        unregister();
        ctx.scene.remove(mesh);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
