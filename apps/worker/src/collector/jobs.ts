/**
 * Stage 1 job implementations. Cadences (FOUNDATION §3):
 *  - poll-opensky 90s  → ~960 global snapshots/day ≈ 3,840 of 4,000 credits
 *  - poll-squawks 60s  → 3 adsb.fi calls/min through the shared rate gate
 *  - sweep-integrity 120s → 6 tile calls per sweep, same gate
 *  - clean-raw 15min   → enforce the 48h raw-file TTL
 */
import type { Redis } from 'ioredis';
import { EMERGENCY_SQUAWKS, GPS_WATCH_REGIONS, type AircraftState } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { fetchGlobalSnapshot } from '../sources/opensky.js';
import { fetchBySquawk, fetchRadius } from '../sources/adsbfi.js';
import { writeSnapshot, writeSquawkState, writeIntegrityState } from './hotState.js';
import { writeRaw, cleanRaw } from '../rawStore.js';
import { log } from '../log.js';

export async function jobPollOpenSky(redis: Redis): Promise<void> {
  const result = await fetchGlobalSnapshot();
  await writeRaw('opensky', 'states', result.raw);
  await writeSnapshot(redis, result);
  log('opensky', 'global poll', {
    aircraft: result.snapshot.aircraft.length,
    creditsRemaining: result.creditsRemaining,
    ...(result.anonymous ? { anonymous: true } : {}),
  });
}

export async function jobPollSquawks(redis: Redis): Promise<void> {
  for (const code of EMERGENCY_SQUAWKS) {
    const { fetchedAt, aircraft, raw } = await fetchBySquawk(code);
    await writeSquawkState(redis, code, fetchedAt, aircraft);
    if (aircraft.length > 0) {
      await writeRaw('adsbfi', `sqk-${code}`, raw);
      log('adsbfi', `squawk ${code} active`, {
        aircraft: aircraft.map((a) => a.hex),
      });
    }
  }
}

export async function jobSweepIntegrity(redis: Redis, db: Queryable): Promise<void> {
  for (const region of GPS_WATCH_REGIONS) {
    const byHex = new Map<string, AircraftState>();
    const raws: unknown[] = [];
    let fetchedAt = 0;
    for (const tile of region.tiles) {
      const result = await fetchRadius(tile.lat, tile.lon, tile.radiusNm);
      raws.push(result.raw);
      fetchedAt = Math.max(fetchedAt, result.fetchedAt);
      for (const a of result.aircraft) {
        const prev = byHex.get(a.hex);
        if (!prev || a.seenAt > prev.seenAt) byHex.set(a.hex, a); // tiles overlap; keep freshest
      }
    }
    const aircraft = [...byHex.values()];
    await writeIntegrityState(redis, region.id, fetchedAt, aircraft);
    await writeRaw('adsbfi', `integrity-${region.id}`, raws);
    const withNic = aircraft.filter((a) => a.nic !== undefined);
    const degraded = withNic.filter((a) => (a.nic as number) <= 4);
    // durable history for D3's per-region norm (5-min buckets, last write wins)
    if (fetchedAt > 0) {
      const bucketTs = new Date(Math.floor(fetchedAt / 300) * 300 * 1000);
      await db.query(
        `INSERT INTO integrity_rollup (bucket_ts, region, aircraft, low_nic)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bucket_ts, region) DO UPDATE
           SET aircraft = EXCLUDED.aircraft, low_nic = EXCLUDED.low_nic`,
        [bucketTs, region.id, withNic.length, degraded.length],
      );
    }
    log('adsbfi', `integrity sweep ${region.id}`, {
      aircraft: aircraft.length,
      withNic: withNic.length,
      lowNic: degraded.length,
    });
  }
}

export async function jobCleanRaw(): Promise<void> {
  const removed = await cleanRaw();
  if (removed > 0) log('rawstore', 'ttl cleanup', { removed });
}
