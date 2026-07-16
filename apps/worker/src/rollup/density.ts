/**
 * Stage 1→2 seam: 5-minute grid-cell density rollups from Redis hot state
 * into Postgres. THE core semantic: if the snapshot is stale, write NOTHING.
 * An absent bucket means "wasn't looking"; a zero would mean "looked, sky was
 * empty" — conflating them poisons baselines and fires false collapse alarms.
 */
import type { Redis } from 'ioredis';
import { REDIS_KEYS, cellIdFor, type GlobalSnapshot } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { log } from '../log.js';

const BUCKET_S = 300;
/** Snapshot older than this at rollup time → skip the bucket entirely. */
const MAX_SNAPSHOT_AGE_S = 300;

export async function jobRollupDensity(redis: Redis, db: Queryable): Promise<void> {
  const raw = await redis.get(REDIS_KEYS.hotSnapshot);
  if (!raw) {
    log('rollup', 'skip — no snapshot in hot state');
    return;
  }
  const snapshot = JSON.parse(raw) as GlobalSnapshot;
  const ageS = Date.now() / 1000 - snapshot.fetchedAt;
  if (ageS > MAX_SNAPSHOT_AGE_S) {
    log('rollup', 'skip — snapshot stale, recording nothing', { ageS: Math.round(ageS) });
    return;
  }

  const counts = new Map<string, number>();
  let airborne = 0;
  for (const a of snapshot.aircraft) {
    if (a.onGround) continue;
    airborne++;
    const cell = cellIdFor(a.lat, a.lon);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }

  const bucketTs = new Date(Math.floor(snapshot.fetchedAt / BUCKET_S) * BUCKET_S * 1000);

  // single multi-row upsert; re-running inside one bucket overwrites (last wins)
  const cells = [...counts.entries()];
  if (cells.length > 0) {
    const values: unknown[] = [bucketTs];
    const tuples = cells.map(([cell, n], i) => {
      values.push(cell, n);
      return `($1, $${i * 2 + 2}, $${i * 2 + 3})`;
    });
    await db.query(
      `INSERT INTO density_rollup (bucket_ts, cell, aircraft) VALUES ${tuples.join(',')}
       ON CONFLICT (bucket_ts, cell) DO UPDATE SET aircraft = EXCLUDED.aircraft`,
      values,
    );
  }
  await db.query(
    `INSERT INTO rollup_run (bucket_ts, total_aircraft, cells, fetched_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bucket_ts) DO UPDATE
       SET total_aircraft = EXCLUDED.total_aircraft,
           cells = EXCLUDED.cells,
           fetched_at = EXCLUDED.fetched_at`,
    [bucketTs, airborne, counts.size, new Date(snapshot.fetchedAt * 1000)],
  );
  log('rollup', 'bucket written', {
    bucket: bucketTs.toISOString(),
    airborne,
    cells: counts.size,
  });
}

/** Rollups older than 60 days are past any baseline window — drop them. */
export async function jobCleanRollups(db: Queryable): Promise<void> {
  const r1 = await db.query(`DELETE FROM density_rollup WHERE bucket_ts < now() - interval '60 days'`);
  const r2 = await db.query(`DELETE FROM rollup_run WHERE bucket_ts < now() - interval '60 days'`);
  const r3 = await db.query(`DELETE FROM integrity_rollup WHERE bucket_ts < now() - interval '60 days'`);
  const removed = (r1.rowCount ?? 0) + (r2.rowCount ?? 0) + (r3.rowCount ?? 0);
  if (removed > 0) log('rollup', 'retention cleanup', { removed });
}
