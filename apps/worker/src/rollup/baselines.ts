/**
 * Stage 2: baselines. Median/MAD per cell × UTC-hour × daytype over the
 * rolling 28-day window (DECISIONS.md #5 — median/MAD because one holiday
 * shreds a mean). Recompute is a full atomic replace: cells that stopped
 * reporting fall out instead of lingering with stale statistics.
 *
 * computeBaselines does NO transaction management and expects to be inside
 * one, on a single dedicated client — jobComputeBaselines wraps it in
 * BEGIN/COMMIT; verifyBaselines.ts wraps it in BEGIN/ROLLBACK against
 * synthetic rows. (Transactions via pool.query would silently span different
 * connections — always a dedicated client.)
 */
import type pg from 'pg';
import { BASELINE_WINDOW_DAYS } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { log } from '../log.js';

const COMPUTE_SQL = `
WITH src AS (
  SELECT cell,
         EXTRACT(HOUR FROM bucket_ts AT TIME ZONE 'UTC')::smallint AS hour,
         CASE WHEN EXTRACT(ISODOW FROM bucket_ts AT TIME ZONE 'UTC') >= 6
              THEN 'weekend' ELSE 'weekday' END AS daytype,
         (bucket_ts AT TIME ZONE 'UTC')::date AS day,
         aircraft
  FROM density_rollup
  WHERE bucket_ts >= now() - ($1 || ' days')::interval
),
med AS (
  SELECT cell, hour, daytype,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY aircraft) AS median,
         count(*) AS samples,
         count(DISTINCT day) AS days
  FROM src
  GROUP BY 1, 2, 3
)
SELECT m.cell, m.hour, m.daytype, m.median, m.samples, m.days,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.aircraft - m.median)) AS mad
FROM src s
JOIN med m USING (cell, hour, daytype)
GROUP BY m.cell, m.hour, m.daytype, m.median, m.samples, m.days
`;

export interface BaselineComputeResult {
  bins: number;
  cells: number;
}

/** Caller owns the transaction and must pass a single dedicated client. */
export async function computeBaselines(client: Queryable): Promise<BaselineComputeResult> {
  const { rows } = await client.query(COMPUTE_SQL, [String(BASELINE_WINDOW_DAYS)]);

  await client.query('DELETE FROM baseline');
  const now = new Date();
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [now];
    const tuples = chunk.map((r, j) => {
      values.push(r.cell, r.hour, r.daytype, r.median, r.mad, r.samples, r.days);
      const o = j * 7 + 1;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $1)`;
    });
    await client.query(
      `INSERT INTO baseline (cell, hour, daytype, median, mad, samples, days, computed_at)
       VALUES ${tuples.join(',')}`,
      values,
    );
  }

  const cells = new Set(rows.map((r) => r.cell)).size;
  return { bins: rows.length, cells };
}

export async function jobComputeBaselines(pool: pg.Pool): Promise<void> {
  const t0 = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await computeBaselines(client);
    await client.query('COMMIT');
    log('baseline', 'recomputed', { ...result, ms: Date.now() - t0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
