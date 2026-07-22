/**
 * One-shot LIVE analyst verification (spends real tokens, ~$0.05):
 *  1. Real Haiku triage of a synthetic-but-realistic S2 signal — validates the
 *     end-to-end path: API call, web-search budget, citation-based sources,
 *     assessment parse/clamp/persist.
 *  2. Sonnet briefing on today's REAL data (dry run — nothing persisted).
 *  3. Sonnet briefing on a synthetic busy day (dry run).
 * The synthetic signal row is deleted afterward; the usage ledger rows stay
 * (real spend, honest ledger). Run: pnpm --filter @orrery/worker verify:live
 */
import { ulid, type Signal } from '@orrery/shared';
import { createPool, ensureSchema } from '../src/db.js';
import { createRedis } from '../src/redis.js';
import { AnalystClient } from '../src/analyst/client.js';
import { triageSignal } from '../src/analyst/jobs.js';
import { assembleBriefingInput, generateBriefing, type BriefingInput } from '../src/analyst/briefing.js';

const pool = createPool();
await ensureSchema(pool);
const redis = createRedis();
const client = new AnalystClient(pool);

if (!client.configured) {
  console.error('ANTHROPIC_API_KEY missing — aborting');
  process.exit(1);
}

const hr = (t: string) => console.log(`\n${'─'.repeat(12)} ${t} ${'─'.repeat(12)}`);

const signal: Signal = {
  id: ulid(),
  ts: new Date().toISOString(),
  source: 'flights',
  detector: 'gps_interference',
  severity: 'S2',
  what: 'Degraded navigation integrity on 41% of aircraft (32 of 78) in the Baltic — Kaliningrad corridor, roughly 3× this region\'s typical level.',
  where: { region: 'Baltic — Kaliningrad corridor', lat: 55.5, lon: 20, radius_km: 460 },
  magnitude: { metric: 'low_nic_fraction', observed: 0.41, baseline: 0.14, deviation: 3.1 },
  confidence: 0.75,
  baseline_maturity: 'warmup',
  data_health: { coverage_ok: true, global_count_delta_pct: -1.2 },
  evidence: {
    window_start: new Date(Date.now() - 600_000).toISOString(),
    window_end: new Date().toISOString(),
    aircraft_count: 78,
    sample_hexes: ['4601f2', '48c1d4', '3c66a9'],
  },
  dedupe_key: 'live-check-synthetic',
};

try {
  hr('1. LIVE TRIAGE (Haiku + web search)');
  await pool.query(
    `INSERT INTO signal (id, ts, source, detector, severity, dedupe_key, payload)
     VALUES ($1, now(), $2, $3, $4, $5, $6)`,
    [signal.id, signal.source, signal.detector, signal.severity, signal.dedupe_key, JSON.stringify(signal)],
  );
  const assessment = await triageSignal(pool, redis, client, signal);
  if (!assessment) throw new Error('triage returned null (breaker?)');
  console.log(`disposition:      ${assessment.disposition}`);
  console.log(`severity_final:   ${assessment.severity_final} (signal was ${signal.severity})`);
  console.log(`confidence:       ${assessment.confidence}`);
  console.log(`sources consulted (from citation blocks, ${assessment.sources_consulted.length}):`);
  for (const s of assessment.sources_consulted) console.log(`  - ${s}`);
  console.log(`narrative:\n  ${assessment.narrative.replace(/\n/g, '\n  ')}`);

  hr('2. BRIEFING — real data, dry run (Sonnet)');
  const real = await assembleBriefingInput(pool);
  const quiet = await generateBriefing(pool, client, { dryRunInput: real });
  console.log(quiet.body);

  hr('3. BRIEFING — synthetic busy day, dry run (Sonnet)');
  const busy: BriefingInput = {
    generatedAt: new Date().toISOString(),
    periodHours: 24,
    warmup: { rollupDays: 9, bins: { mature: 120, partial: 9800, warmup: 4200 } },
    dataHealth: {
      bucketsExpected: 288,
      bucketsPresent: 271,
      coverageIncidents: ['Global aircraft count fell 34% against the 1h median at 02:10Z, recovered by 02:45Z.'],
    },
    signals: {
      s1: [{
        payload: { what: 'JAL512 squawking 7500 (unlawful interference), persistent across 4 independent observations, en route Tokyo–Sapporo.' },
        narrative: 'No public reporting found. Aircraft continued normal routing and landed on schedule; transponder reverted to 2000 after 11 minutes.',
        disposition: 'unexplained', confidence: 0.55, sources: [],
      }],
      s2: [{
        payload: { what: 'Commercial traffic over the eastern Black Sea cell N40E035 thinned 47% against a partial baseline around 03:00Z and has not recovered.' },
        narrative: 'Two regional NOTAM-adjacent news items reference temporary airspace restrictions; could account for the reduction.',
        disposition: 'explained', confidence: 0.7,
        sources: ['https://example.com/aviation-news'],
      }],
      s2Count: 1,
      s2ByDetector: { traffic_collapse: 1 },
      s3Count: 11,
      s3Sample: ['UAL233 squawking 7700 (general emergency).', 'Degraded nav integrity 22% over Persian Gulf watch region.'],
    },
  };
  const busyOut = await generateBriefing(pool, client, { dryRunInput: busy });
  console.log(busyOut.body);

  hr('COST');
  const { rows } = await pool.query(
    `SELECT kind, model, input_tokens, output_tokens, web_searches, est_cost_usd
     FROM analyst_usage ORDER BY ts DESC LIMIT 3`,
  );
  let total = 0;
  for (const r of rows.reverse()) {
    total += r.est_cost_usd;
    console.log(`${r.kind.padEnd(9)} ${r.model}  in=${r.input_tokens} out=${r.output_tokens} searches=${r.web_searches}  $${r.est_cost_usd.toFixed(4)}`);
  }
  console.log(`total this check: $${total.toFixed(4)}`);
} finally {
  await pool.query(`DELETE FROM assessment WHERE signal_id = $1`, [signal.id]);
  await pool.query(`DELETE FROM signal WHERE id = $1`, [signal.id]);
  redis.disconnect();
  await pool.end();
}
console.log('\nLive analyst check complete (synthetic signal cleaned up).');
