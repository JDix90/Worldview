/**
 * SGP4 propagation off the main thread. Receives TLEs, ticks on an interval,
 * posts geodetic positions as a transferable Float32Array [lat°, lon°, altKm]×N
 * (NaN lat marks a failed/decayed propagation). The main thread interpolates
 * between successive frames — SGP4 never runs on the render loop.
 */
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
  type SatRec,
} from 'satellite.js';

interface InitMsg {
  type: 'init';
  tles: Array<{ l1: string; l2: string }>;
  tickMs: number;
}

const wctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<InitMsg>) => void) | null;
};

let satrecs: (SatRec | null)[] = [];
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  const now = new Date();
  const gmst = gstime(now);
  const out = new Float32Array(satrecs.length * 3);
  for (let i = 0; i < satrecs.length; i++) {
    out[i * 3] = NaN;
    const rec = satrecs[i];
    if (!rec) continue;
    try {
      const pv = propagate(rec, now);
      const p = pv?.position;
      if (!p || typeof p === 'boolean') continue;
      const geo = eciToGeodetic(p, gmst);
      out[i * 3] = degreesLat(geo.latitude);
      out[i * 3 + 1] = degreesLong(geo.longitude);
      out[i * 3 + 2] = geo.height;
    } catch {
      /* decayed / bad elements — stays NaN */
    }
  }
  wctx.postMessage({ type: 'positions', t: Date.now(), positions: out }, [out.buffer]);
}

wctx.onmessage = (ev: MessageEvent<InitMsg>) => {
  if (ev.data.type !== 'init') return;
  clearInterval(timer);
  satrecs = ev.data.tles.map((t) => {
    try {
      return twoline2satrec(t.l1, t.l2);
    } catch {
      return null;
    }
  });
  tick();
  timer = setInterval(tick, ev.data.tickMs);
};
