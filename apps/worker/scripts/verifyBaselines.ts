/**
 * Baseline math + maturity verification against synthetic rollups, executed
 * inside a transaction that is ALWAYS rolled back — the real tables are
 * untouched (asserted). Run: pnpm --filter @orrery/worker verify:baselines
 *
 * Proves the chunk 4 DoD line "maturity transitions provably follow data
 * volume" without waiting weeks of wall-clock.
 */
import { maturityOf, type Daytype } from '@orrery/shared';
import { createPool, ensureSchema } from '../src/db.js';
import { computeBaselines } from '../src/rollup/baselines.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Most recent N distinct days of the given daytype, newest first (UTC). */
function recentDays(daytype: Daytype, n: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    if ((daytype === 'weekend') === isWeekend) out.push(new Date(d));
  }
  return out;
}

const pool = createPool();
await ensureSchema(pool);
const client = await pool.connect();

try {
  const before = await client.query('SELECT count(*)::int AS n FROM baseline');

  await client.query('BEGIN');

  const insert = async (cell: string, day: Date, aircraft: number) => {
    await client.query(
      'INSERT INTO density_rollup (bucket_ts, cell, aircraft) VALUES ($1, $2, $3)',
      [day, cell, aircraft],
    );
  };

  // ZTESTA: 16 weekdays at hour 12, values 100 + (i % 5) → median 102, MAD 1 exactly
  const daysA = recentDays('weekday', 16);
  for (let i = 0; i < daysA.length; i++) await insert('ZTESTA', daysA[i]!, 100 + (i % 5));

  // ZTESTB: 19 weekdays of 50 and one recorded-zero day → median must ignore it
  const daysB = recentDays('weekday', 20);
  for (let i = 0; i < daysB.length; i++) await insert('ZTESTB', daysB[i]!, i === 7 ? 0 : 50);

  // maturity ladder
  for (const d of recentDays('weekday', 3)) await insert('ZTESTC', d, 10);
  for (const d of recentDays('weekday', 8)) await insert('ZTESTD', d, 10);
  for (const d of recentDays('weekend', 1)) await insert('ZTESTE', d, 10);
  for (const d of recentDays('weekend', 3)) await insert('ZTESTF', d, 10);
  for (const d of recentDays('weekend', 6)) await insert('ZTESTG', d, 10);

  await computeBaselines(client);

  const { rows } = await client.query(
    `SELECT cell, hour, daytype, median, mad, samples, days
     FROM baseline WHERE cell LIKE 'ZTEST%' AND hour = 12`,
  );
  const byCell = new Map(rows.map((r) => [r.cell as string, r]));

  const a = byCell.get('ZTESTA');
  check('ZTESTA median exact', a?.median === 102, `median=${a?.median}`);
  check('ZTESTA MAD exact', a?.mad === 1, `mad=${a?.mad}`);
  check('ZTESTA days counted', a?.days === 16, `days=${a?.days}`);
  check('ZTESTA maturity mature (16/20 weekdays)', maturityOf(a?.days ?? 0, 'weekday') === 'mature');

  const b = byCell.get('ZTESTB');
  check('ZTESTB median robust to outage-day zero', b?.median === 50, `median=${b?.median}`);

  const ladder: Array<[string, Daytype, number, string]> = [
    ['ZTESTC', 'weekday', 3, 'warmup'],
    ['ZTESTD', 'weekday', 8, 'partial'],
    ['ZTESTE', 'weekend', 1, 'warmup'],
    ['ZTESTF', 'weekend', 3, 'partial'],
    ['ZTESTG', 'weekend', 6, 'mature'],
  ];
  for (const [cell, daytype, wantDays, wantMaturity] of ladder) {
    const r = byCell.get(cell);
    const maturity = maturityOf(r?.days ?? 0, daytype);
    check(
      `${cell} ${wantDays} ${daytype} day(s) → ${wantMaturity}`,
      r?.days === wantDays && maturity === wantMaturity,
      `days=${r?.days} maturity=${maturity}`,
    );
  }

  await client.query('ROLLBACK');

  const after = await client.query('SELECT count(*)::int AS n FROM baseline');
  check('rollback left real baseline table untouched', before.rows[0].n === after.rows[0].n,
    `${before.rows[0].n} → ${after.rows[0].n}`);
} finally {
  client.release();
  await pool.end();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll baseline checks passed.');
