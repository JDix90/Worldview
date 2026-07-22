/**
 * Analyst logic checks with a mocked API transport (no tokens spent) and a
 * rolled-back Postgres transaction (no trace). Covers: assessment parsing,
 * the downgrade-only clamp, citation-based source extraction, cost math,
 * the circuit breaker, and briefing generation on a synthetic busy day.
 * Run: pnpm --filter @orrery/worker verify:analyst
 */
import type Anthropic from '@anthropic-ai/sdk';
import { ulid, type Signal } from '@orrery/shared';
import { createPool, ensureSchema } from '../src/db.js';
import { AnalystClient, estimateCostUsd } from '../src/analyst/client.js';
import { parseAssessment, extractConsultedSources } from '../src/analyst/triage.js';
import { generateBriefing, type BriefingInput } from '../src/analyst/briefing.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function textBlock(text: string, citations?: Array<{ url: string }>): Anthropic.ContentBlock {
  return {
    type: 'text',
    text,
    citations: citations?.map((c) => ({
      type: 'web_search_result_location',
      url: c.url,
      title: 't',
      cited_text: '',
      encrypted_index: '',
    })),
  } as Anthropic.ContentBlock;
}

const signal: Signal = {
  id: ulid(),
  ts: new Date().toISOString(),
  source: 'flights',
  detector: 'emergency_squawk',
  severity: 'S2',
  what: 'TEST cluster',
  where: { region: 'N50E000', lat: 52, lon: 2 },
  magnitude: { metric: 'squawk_7700_cluster', observed: 2, baseline: 0, deviation: 0 },
  confidence: 0.8,
  baseline_maturity: 'n/a',
  data_health: { coverage_ok: true, global_count_delta_pct: 0 },
  evidence: { window_start: '', window_end: '' },
  dedupe_key: 'test',
};

// ── parsing & clamp ───────────────────────────────────────────────────
const good = [textBlock(
  'Assessment follows.\n```json\n{"disposition":"unexplained","severity_final":"S2","narrative":"No public reporting found.","confidence":0.6}\n```',
  [{ url: 'https://example.com/news' }],
)];
const a1 = parseAssessment(good, signal, 'm');
check('assessment parsed', a1.disposition === 'unexplained' && a1.confidence === 0.6);
check('sources from citation blocks, not model claims', a1.sources_consulted.join() === 'https://example.com/news');

const upgrade = [textBlock('```json\n{"disposition":"unexplained","severity_final":"S1","narrative":"n","confidence":0.9}\n```')];
check('upgrade attempt clamped to signal severity', parseAssessment(upgrade, signal, 'm').severity_final === 'S2');

const downgrade = [textBlock('```json\n{"disposition":"noise","severity_final":"S3","narrative":"n","confidence":0.9}\n```')];
check('downgrade allowed', parseAssessment(downgrade, signal, 'm').severity_final === 'S3');

let threw = false;
try { parseAssessment([textBlock('no fence here')], signal, 'm'); } catch { threw = true; }
check('missing json fence throws (retryable)', threw);

// ── cost math ─────────────────────────────────────────────────────────
check('haiku cost math', Math.abs(estimateCostUsd('claude-haiku-4-5-20251001', 1000, 500, 1) - (0.001 + 0.0025 + 0.01)) < 1e-9);
check('unknown model uses expensive fallback', estimateCostUsd('mystery', 1_000_000, 0, 0) === 3);

// ── breaker + briefing against real (rolled-back) PG ──────────────────
const pool = createPool();
await ensureSchema(pool);
const client = await pool.connect();
const usageBefore = await client.query('SELECT count(*)::int AS n FROM analyst_usage');
await client.query('BEGIN');
try {
  let transportCalls = 0;
  let lastParams: Anthropic.MessageCreateParamsNonStreaming | null = null;
  const mockTransport = async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    transportCalls++;
    lastParams = params;
    return {
      content: [textBlock('Quiet where it counts. Two emergencies, both mundane. Nothing of note otherwise.')],
      usage: { input_tokens: 900, output_tokens: 150 },
    } as unknown as Anthropic.Message;
  };
  const analyst = AnalystClient.withTransport(client, mockTransport);

  const busy: BriefingInput = {
    generatedAt: new Date().toISOString(),
    periodHours: 24,
    warmup: { rollupDays: 1, bins: { mature: 0, partial: 0, warmup: 334 } },
    dataHealth: { bucketsExpected: 288, bucketsPresent: 280, coverageIncidents: [] },
    signals: {
      s1: [],
      s2: [{ payload: { what: 'SYNTHETIC 7700 cluster over the North Sea' }, disposition: 'unexplained' }],
      s2Count: 1,
      s2ByDetector: { emergency_squawk: 1 },
      s3Count: 4,
      s3Sample: ['SYNTHETIC squawk 7600'],
    },
  };
  const out = await generateBriefing(client, analyst, { dryRunInput: busy });
  check('briefing generated via transport', transportCalls === 1 && out.body.includes('Nothing of note'));
  check('busy day not marked quiet', out.quiet === false);
  const sent = JSON.stringify(lastParams);
  check('synthetic signals reached the prompt', sent.includes('SYNTHETIC 7700 cluster'));
  check('briefing sends no web-search tool', !sent.includes('web_search'));
  check(
    'usage row recorded',
    (await client.query(`SELECT count(*)::int AS n FROM analyst_usage`)).rows[0].n ===
      usageBefore.rows[0].n + 1,
  );

  // trip the breaker, expect degradation without a transport call
  await client.query(
    `INSERT INTO analyst_usage (id, ts, kind, model, input_tokens, output_tokens, web_searches, est_cost_usd)
     VALUES ($1, now(), 'triage', 'm', 0, 0, 0, 99)`,
    [ulid()],
  );
  const capped = await generateBriefing(client, analyst, { dryRunInput: busy });
  check('breaker → degraded briefing, no API call', transportCalls === 1 && capped.body.includes('spend cap'));
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll analyst checks passed.');
