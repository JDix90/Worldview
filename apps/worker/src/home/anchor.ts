/**
 * The home point for the home briefing (FOUNDATION §12).
 *
 * In order of preference:
 *  1. HOME_LAT / HOME_LON from the appliance's .env: the precise point. It
 *     never enters the repo, a prompt, or an upstream query (DECISIONS #144).
 *  2. Redis `settings:home`: the server's anchor, which POST /api/settings/home
 *     (the globe's HOME chip) rounds to 0.01°.
 *  3. OWNER_LAT / OWNER_LON, the same Denver default the server falls back to.
 */
import type { Redis } from 'ioredis';
import { env } from '../env.js';

export interface HomeAnchor {
  lat: number;
  lon: number;
  /** True only for the .env point; false means already rounded or default. */
  precise: boolean;
}

export async function resolveHomeAnchor(redis: Pick<Redis, 'get'>): Promise<HomeAnchor> {
  if (Number.isFinite(env.homeLat) && Number.isFinite(env.homeLon)) {
    return { lat: env.homeLat, lon: env.homeLon, precise: true };
  }
  try {
    const raw = await redis.get('settings:home');
    if (raw) {
      const h = JSON.parse(raw) as { lat?: unknown; lon?: unknown };
      if (typeof h.lat === 'number' && typeof h.lon === 'number') return { lat: h.lat, lon: h.lon, precise: false };
    }
  } catch {
    /* fall through to the default */
  }
  return { lat: env.ownerLat, lon: env.ownerLon, precise: false };
}

/** What an upstream query may see: the value rounded to `places` decimals. */
export function coarsen(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

const DEG = Math.PI / 180;

/** Great-circle distance in statute miles. */
export function distMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * ArcGIS envelope (xmin,ymin,xmax,ymax) that covers `radiusMi` around the
 * anchor without revealing it: centred on the anchor rounded to 0.01° and
 * padded by 0.006° (more than the ≤0.005° rounding error) on every side.
 */
export function coarseBox(home: Pick<HomeAnchor, 'lat' | 'lon'>, radiusMi: number): string {
  const cLat = coarsen(home.lat, 2);
  const cLon = coarsen(home.lon, 2);
  const dLat = radiusMi / 69 + 0.006;
  const dLon = radiusMi / (69 * Math.cos(cLat * DEG)) + 0.006;
  const f = (v: number) => v.toFixed(3);
  return `${f(cLon - dLon)},${f(cLat - dLat)},${f(cLon + dLon)},${f(cLat + dLat)}`;
}
