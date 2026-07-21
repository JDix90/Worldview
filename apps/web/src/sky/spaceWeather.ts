/**
 * Space weather from NOAA SWPC — keyless, CORS-open (verified 2026-07-21):
 *  - Kp now + 3-day forecast: products/noaa-planetary-k-index-forecast.json
 *  - X-ray: json/goes/primary/xray-flares-latest.json (current_class direct)
 *  - Solar wind: products/geospace/propagated-solar-wind-1-hour.json
 * Plus an aurora-at-your-latitude verdict via a dipole geomagnetic-latitude
 * approximation (2025 CGM north pole ≈ 80.9°N 72.7°W).
 */

const BASE = 'https://services.swpc.noaa.gov';

export interface SpaceWeather {
  kpNow: number | null;
  kpMax24h: number | null; // max predicted Kp in the next 24 h
  xrayClass: string | null; // e.g. "C1.7"
  lastFlare: string | null; // e.g. "C2.5 at 01:58Z"
  windKms: number | null; // km/s
  windBz: number | null; // nT (southward negative = geoeffective)
}

export async function fetchSpaceWeather(): Promise<SpaceWeather> {
  const out: SpaceWeather = { kpNow: null, kpMax24h: null, xrayClass: null, lastFlare: null, windKms: null, windBz: null };

  try {
    const rows = (await (await fetch(`${BASE}/products/noaa-planetary-k-index-forecast.json`)).json()) as Array<{
      time_tag: string; kp: number; observed: string;
    }>;
    const nowMs = Date.now();
    const observed = rows.filter((r) => r.observed === 'observed' || r.observed === 'estimated');
    if (observed.length) out.kpNow = observed[observed.length - 1]!.kp;
    const next24 = rows.filter(
      (r) => r.observed === 'predicted' && Date.parse(`${r.time_tag}Z`) - nowMs < 24 * 3600_000 && Date.parse(`${r.time_tag}Z`) > nowMs - 3 * 3600_000,
    );
    if (next24.length) out.kpMax24h = Math.max(...next24.map((r) => r.kp));
  } catch { /* absent */ }

  try {
    const flares = (await (await fetch(`${BASE}/json/goes/primary/xray-flares-latest.json`)).json()) as Array<{
      current_class?: string; max_class?: string; max_time?: string;
    }>;
    const f = flares[0];
    if (f) {
      out.xrayClass = f.current_class ?? null;
      if (f.max_class && f.max_time) out.lastFlare = `${f.max_class} at ${f.max_time.slice(11, 16)}Z`;
    }
  } catch { /* absent */ }

  try {
    const rows = (await (await fetch(`${BASE}/products/geospace/propagated-solar-wind-1-hour.json`)).json()) as string[][];
    const last = rows[rows.length - 1];
    if (last && rows.length > 1) {
      out.windKms = Math.round(Number(last[1]));
      out.windBz = Math.round(Number(last[6]) * 10) / 10;
    }
  } catch { /* absent */ }

  return out;
}

const DEG = Math.PI / 180;
/** Dipole-approximation geomagnetic latitude (good to a few degrees). */
export function geomagneticLat(lat: number, lon: number): number {
  const pLat = 80.9 * DEG, pLon = -72.7 * DEG;
  const d = Math.acos(
    Math.sin(lat * DEG) * Math.sin(pLat) +
      Math.cos(lat * DEG) * Math.cos(pLat) * Math.cos(lon * DEG - pLon),
  );
  return 90 - d / DEG;
}

export type AuroraVerdict = 'none' | 'horizon' | 'overhead';

/** Practical visibility: auroral-oval equatorward boundary ≈ maglat 66 − 2·Kp;
 * within 5° below the boundary = low on the northern horizon. */
export function auroraVerdict(kp: number | null, lat: number, lon: number): AuroraVerdict {
  if (kp == null) return 'none';
  const maglat = Math.abs(geomagneticLat(lat, lon));
  const boundary = 66 - 2 * kp;
  if (maglat >= boundary) return 'overhead';
  if (maglat >= boundary - 5) return 'horizon';
  return 'none';
}
