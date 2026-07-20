/**
 * Callsign → route (origin/destination city) via adsbdb.com — the server-side
 * twin of apps/web/src/feed/routes.ts, used to give pager squawk signals
 * their "Chicago → Denver" context. Called only for the ≤5 S1/S2 signals a
 * summary returns; Redis-cached 24 h (positive) / in-memory for the process
 * lifetime (negative — GA and military callsigns rarely gain routes mid-day).
 */
import type { Redis } from 'ioredis';

const API = 'https://api.adsbdb.com/v0/callsign/';
const TTL_S = 24 * 3600;

const negative = new Set<string>();

interface AdsbdbAirport {
  municipality?: string;
  iata_code?: string;
}

export async function routeLabel(redis: Redis, callsign: string | undefined): Promise<string | null> {
  const cs = callsign?.trim().toUpperCase();
  if (!cs || negative.has(cs)) return null;

  const key = `route:${cs}`;
  const cached = await redis.get(key);
  if (cached) return cached === '-' ? null : cached;

  try {
    const res = await fetch(API + encodeURIComponent(cs), {
      headers: { 'user-agent': 'ORRERY (personal, non-commercial)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`adsbdb HTTP ${res.status}`);
    const data = (await res.json()) as {
      response?: { flightroute?: { origin?: AdsbdbAirport; destination?: AdsbdbAirport } };
    };
    const fr = data.response?.flightroute;
    const o = fr?.origin?.municipality;
    const d = fr?.destination?.municipality;
    if (o && d) {
      const label = `${o} → ${d}`;
      await redis.set(key, label, 'EX', TTL_S);
      return label;
    }
    negative.add(cs);
    await redis.set(key, '-', 'EX', TTL_S);
    return null;
  } catch {
    negative.add(cs); // don't hammer on failure; process restart clears
    return null;
  }
}
