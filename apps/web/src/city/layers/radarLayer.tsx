/**
 * RADAR — live precipitation over the city (RainViewer, round 1 L1, #125).
 * Keyless + CORS `*` (verified 2026-07-22); the Pi RADAR page (#121) proved
 * the tile path and the nearness math. ~10-minute product; the newest past
 * frame only — this is "is that storm going to hit me?", not an animation.
 */
import { TILE, type CityLayerDef, type MercatorView } from '../registry';

/**
 * RainViewer's 256px tiles top out at z7 — beyond that the server returns a
 * "Zoom Level Not Supported" placeholder (found live during W1 verification:
 * z8+ tiles are identical 1370-byte text tiles; z5–7 are real data). The
 * city view runs z11/z13, so radar renders as over-zoomed z7 tiles scaled
 * up — blurry by nature, which is honest: radar resolution is km-scale.
 */
const RADAR_MAX_Z = 7;

interface RadarFrame {
  host: string;
  path: string;
  /** Unix seconds of the frame — legend shows honest age. */
  time: number;
}

async function fetchFrame(): Promise<RadarFrame> {
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RainViewer: HTTP ${res.status}`);
  const d = (await res.json()) as { host?: string; radar?: { past?: Array<{ time: number; path: string }> } };
  const past = d.radar?.past ?? [];
  const last = past[past.length - 1];
  if (!d.host || !last) throw new Error('RainViewer: no frames');
  return { host: d.host, path: last.path, time: last.time };
}

function ageMin(t: number): number {
  return Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
}

export const radarLayer: CityLayerDef<RadarFrame> = {
  id: 'radar',
  label: 'RADAR',
  chipColor: '#7fd07f',
  defaultOn: true,
  describe: 'live precipitation radar — RainViewer, ~10 min product',
  attribution: 'radar © RainViewer',

  fetchEager: () => fetchFrame(),
  pollWhileOpenMs: 10 * 60_000,

  count: () => null,

  renderUnder: (frame, view: MercatorView) => {
    const zr = Math.min(view.z, RADAR_MAX_Z);
    const k = 2 ** (view.z - zr); // over-zoom scale factor
    const T = TILE * k; // one radar tile's size in view px
    const n = 2 ** zr;
    const tiles: Array<{ x: number; y: number; left: number; top: number }> = [];
    for (let tx = Math.floor(view.originX / T); tx <= Math.floor((view.originX + view.w) / T); tx++) {
      for (let ty = Math.floor(view.originY / T); ty <= Math.floor((view.originY + view.h) / T); ty++) {
        if (ty < 0 || ty >= n) continue;
        tiles.push({ x: ((tx % n) + n) % n, y: ty, left: tx * T - view.originX, top: ty * T - view.originY });
      }
    }
    return (
      <>
        {tiles.map((t) => (
          <img
            key={`${zr}/${t.x}/${t.y}`}
            src={`${frame.host}${frame.path}/256/${zr}/${t.x}/${t.y}/2/1_1.png`}
            width={T}
            height={T}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            style={{ position: 'absolute', left: t.left, top: t.top, opacity: 0.55, userSelect: 'none' }}
          />
        ))}
      </>
    );
  },

  legend: (frame) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: '#7fd07f' }}>▦</span> radar · {ageMin(frame.time)}m old
    </span>
  ),
};
