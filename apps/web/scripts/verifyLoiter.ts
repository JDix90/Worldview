/**
 * Pure checks for the loiter heuristic — synthetic tracks, no browser.
 * Run: pnpm dlx tsx apps/web/scripts/verifyLoiter.ts
 */
import { assessTrack, type TrackSample } from '../src/city/loiterHeuristic';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const NOW = 1_800_000_000_000;
const HOME = { lat: 39.75, lon: -104.99 };

/** n samples over `min` minutes via a position function of phase 0..1. */
function track(min: number, n: number, f: (k: number) => { lat: number; lon: number }): TrackSample[] {
  return Array.from({ length: n }, (_, i) => {
    const k = i / (n - 1);
    const p = f(k);
    return { t: NOW - min * 60_000 + k * min * 60_000, lat: p.lat, lon: p.lon, altFt: 3000 };
  });
}

// 1. Helicopter orbit: ~1.2 mi radius circle, 3 laps over 12 min.
const orbit = track(12, 36, (k) => ({
  lat: HOME.lat + 0.017 * Math.sin(k * 6 * Math.PI),
  lon: HOME.lon + 0.022 * Math.cos(k * 6 * Math.PI),
}));
const vOrbit = assessTrack(orbit, NOW)!;
check('orbiting helicopter flags', vOrbit.loitering, JSON.stringify(vOrbit));

// 2. Transiting airliner: straight line ~40 mi over 10 min.
const transit = track(10, 30, (k) => ({ lat: HOME.lat + 0.55 * k - 0.27, lon: HOME.lon + 0.1 * k }));
const vTransit = assessTrack(transit, NOW)!;
check('transiting airliner does NOT flag', !vTransit.loitering, JSON.stringify(vTransit));

// 3. Hovering helo: ~stationary with GPS jitter, 8 min.
const hover = track(8, 24, (k) => ({
  lat: HOME.lat + 0.001 * Math.sin(k * 40),
  lon: HOME.lon + 0.001 * Math.cos(k * 31),
}));
const vHover = assessTrack(hover, NOW)!;
check('hovering helo flags (hover clause)', vHover.loitering, JSON.stringify(vHover));

// 4. Racetrack hold: 2 mi × 0.5 mi oval, 4 laps in 14 min.
const hold = track(14, 42, (k) => ({
  lat: HOME.lat + 0.007 * Math.sin(k * 8 * Math.PI),
  lon: HOME.lon + 0.029 * Math.cos(k * 8 * Math.PI),
}));
const vHold = assessTrack(hold, NOW)!;
check('racetrack hold flags', vHold.loitering, JSON.stringify(vHold));

// 5. Too little observation: 3 min of orbiting → null (cold-start honesty).
const brief = track(3, 9, (k) => ({
  lat: HOME.lat + 0.017 * Math.sin(k * 2 * Math.PI),
  lon: HOME.lon + 0.022 * Math.cos(k * 2 * Math.PI),
}));
check('3-minute observation returns null (insufficient dwell)', assessTrack(brief, NOW) === null);

// 6. Landing pattern: one descending loop then away — dwell 5 min → not flagged.
const pattern = track(5, 15, (k) => ({
  lat: HOME.lat + 0.02 * Math.sin(k * 2 * Math.PI) + 0.1 * k,
  lon: HOME.lon + 0.02 * Math.cos(k * 2 * Math.PI),
}));
const vPattern = assessTrack(pattern, NOW);
check('5-minute pattern does NOT flag', vPattern === null || !vPattern.loitering,
  vPattern ? JSON.stringify(vPattern) : 'null');

// 7. Stale samples outside the 20-min window are ignored.
const stale: TrackSample[] = [
  ...track(60, 30, (k) => ({ lat: HOME.lat + 0.017 * Math.sin(k * 9), lon: HOME.lon + 0.022 * Math.cos(k * 9) }))
    .map((s) => ({ ...s, t: s.t - 40 * 60_000 })),
];
check('stale-only buffer returns null', assessTrack(stale, NOW) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
