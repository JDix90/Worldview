/**
 * Redis hot state — what the globe renders (FOUNDATION §2). Written whole on
 * every poll; the server (chunk 3) reads and diffs for the WebSocket.
 */
import type { Redis } from 'ioredis';
import { REDIS_KEYS, type AircraftState } from '@orrery/shared';
import type { OpenSkyPollResult } from '../sources/opensky.js';

export async function writeSnapshot(redis: Redis, result: OpenSkyPollResult): Promise<void> {
  const { snapshot } = result;
  await redis.set(REDIS_KEYS.hotSnapshot, JSON.stringify(snapshot));
  await redis.hset(REDIS_KEYS.hotSnapshotMeta, {
    fetchedAt: snapshot.fetchedAt,
    count: snapshot.aircraft.length,
    creditsRemaining: result.creditsRemaining ?? '',
    anonymous: result.anonymous ? '1' : '0',
    updatedAtMs: Date.now(),
  });

  // Our own credit accounting (4 credits per global /states/all), so the
  // budget check in the DoD doesn't depend on trusting response headers.
  const day = new Date().toISOString().slice(0, 10);
  const key = REDIS_KEYS.openskyCredits(day);
  await redis.incrby(key, 4);
  await redis.expire(key, 3 * 86400);
}

export async function writeSquawkState(
  redis: Redis,
  code: string,
  fetchedAt: number,
  aircraft: AircraftState[],
): Promise<void> {
  await redis.set(REDIS_KEYS.hotSquawk(code), JSON.stringify({ fetchedAt, aircraft }));
}

export async function writeIntegrityState(
  redis: Redis,
  regionId: string,
  fetchedAt: number,
  aircraft: AircraftState[],
): Promise<void> {
  await redis.set(REDIS_KEYS.hotIntegrity(regionId), JSON.stringify({ fetchedAt, aircraft }));
}
