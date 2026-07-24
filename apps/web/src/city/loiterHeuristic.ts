/**
 * Loiter heuristic (round 1 L4, #125) — pure math, no imports, verifiable
 * off-browser (scripts/verifyLoiter.ts runs it over synthetic tracks).
 *
 * DISCIPLINE NOTE: this is a *display heuristic in furniture* — it produces
 * no signals, no severities, and never touches the pipeline. A real loiter
 * detector (baselines, corroboration, analyst triage) is a Phase 2 pipeline
 * candidate post-gate; this is the map answering "why is that helicopter
 * circling?" from data the page already holds.
 *
 * A track "loiters" when it dwells: enough observed minutes, confined to a
 * small radius, and either path-heavy for its net displacement (circling,
 * racetrack holds) or nearly stationary (hover). Airliners in transit fail
 * the radius test; landing patterns fail the dwell test.
 */

export interface TrackSample {
  t: number; // ms
  lat: number;
  lon: number;
  altFt: number | null;
}

export interface LoiterVerdict {
  loitering: boolean;
  dwellMin: number;
  radiusMi: number;
  pathMi: number;
  netMi: number;
  ratio: number;
}

const DEG = Math.PI / 180;
function distMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const h =
    Math.sin(((bLat - aLat) * DEG) / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(((bLon - aLon) * DEG) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export const LOITER_WINDOW_MS = 20 * 60_000;
export const MIN_DWELL_MIN = 6;
export const MIN_SAMPLES = 8;
export const MAX_RADIUS_MI = 3;
export const MIN_PATH_MI = 4;
export const MIN_RATIO = 3.5;
/** Hover clause: tiny radius + almost no net movement (news/police helo). */
export const HOVER_RADIUS_MI = 1;
export const HOVER_NET_MI = 0.5;

export function assessTrack(samples: TrackSample[], nowMs: number): LoiterVerdict | null {
  const win = samples.filter((s) => nowMs - s.t <= LOITER_WINDOW_MS);
  if (win.length < MIN_SAMPLES) return null;
  const dwellMin = (win[win.length - 1]!.t - win[0]!.t) / 60_000;
  if (dwellMin < MIN_DWELL_MIN) return null;

  let cLat = 0, cLon = 0;
  for (const s of win) { cLat += s.lat; cLon += s.lon; }
  cLat /= win.length; cLon /= win.length;

  let radiusMi = 0, pathMi = 0;
  for (let i = 0; i < win.length; i++) {
    radiusMi = Math.max(radiusMi, distMi(cLat, cLon, win[i]!.lat, win[i]!.lon));
    if (i > 0) pathMi += distMi(win[i - 1]!.lat, win[i - 1]!.lon, win[i]!.lat, win[i]!.lon);
  }
  const netMi = distMi(win[0]!.lat, win[0]!.lon, win[win.length - 1]!.lat, win[win.length - 1]!.lon);
  const ratio = pathMi / Math.max(netMi, 0.1);

  const circling = radiusMi <= MAX_RADIUS_MI && pathMi >= MIN_PATH_MI && ratio >= MIN_RATIO;
  const hovering = radiusMi <= HOVER_RADIUS_MI && netMi <= HOVER_NET_MI && dwellMin >= MIN_DWELL_MIN;

  return {
    loitering: circling || hovering,
    dwellMin: Math.round(dwellMin * 10) / 10,
    radiusMi: Math.round(radiusMi * 100) / 100,
    pathMi: Math.round(pathMi * 100) / 100,
    netMi: Math.round(netMi * 100) / 100,
    ratio: Math.round(ratio * 10) / 10,
  };
}
