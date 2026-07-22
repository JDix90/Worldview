/**
 * The daily briefing — Sonnet, 07:00 America/Denver, implementing the voice
 * spec (FOUNDATION §9). Input assembly is code: the model only ever sees a
 * compact structured summary, never raw data. No web search here — searches
 * are spent on S1/S2 triage only (FOUNDATION §8).
 */
import { ulid } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { env } from '../env.js';
import { log } from '../log.js';
import type { AnalystClient } from './client.js';

export const BRIEFING_SYSTEM = `You write the daily briefing for ORRERY, a personal flight-anomaly instrument watched by one person. You are the night-watch duty officer filing at dawn: laconic, dry, unhurried, faintly wry. You have seen a lot of quiet nights and are not impressed by much.

Rules — these are hard requirements:
- Lead with what changed, then what it might mean, then what you explicitly do not know.
- Distinguish observed (the data says) / inferred (this pattern usually means) / unknown (no explanation found).
- Never breathless. No "BREAKING", no exclamation points, no emoji.
- If nothing is notable, say "nothing of note" early and keep the whole briefing under 80 words. Do not manufacture interest.
- State confidence plainly where you make a judgment.
- Name only sources that appear in the assessments given to you. You have no NOTAM access and never claim one; "no public reporting found" is the honest phrasing.
- If baselines are marked immature, say the instrument is still learning what normal looks like — do not dress thin statistics as findings.
- Plain markdown, no headers deeper than one level, 400 words maximum. Sign off with a single dry line.`;

export interface BriefingInput {
  generatedAt: string;
  periodHours: number;
  warmup: { rollupDays: number; bins: { mature: number; partial: number; warmup: number } };
  dataHealth: { bucketsExpected: number; bucketsPresent: number; coverageIncidents: string[] };
  signals: {
    s1: unknown[];
    s2: unknown[];
    /** Total S2s in the window; s2 above carries only the S2_DETAIL_CAP most
     *  recent in full (DECISIONS #109 — a 40-signal day was inflating the
     *  Sonnet input ~10× and the briefing cost with it). */
    s2Count: number;
    s2ByDetector: Record<string, number>;
    s3Count: number;
    s3Sample: string[];
  };
  /** Sunday only: the week's would-have-pushed log for calibration review. */
  shadowWeek?: unknown[];
}

/** Full-detail S2 rows in the briefing input; the rest arrive as counts. */
const S2_DETAIL_CAP = 15;

export async function assembleBriefingInput(db: Queryable): Promise<BriefingInput> {
  const [rollupDays, bins, buckets, incidents, s1, s2, s2Counts, s3] = await Promise.all([
    db.query(`SELECT count(DISTINCT (bucket_ts AT TIME ZONE 'UTC')::date)::int AS d FROM rollup_run`),
    db.query(`SELECT
        count(*) FILTER (WHERE days >= CASE WHEN daytype='weekend' THEN 6 ELSE 15 END)::int AS mature,
        count(*) FILTER (WHERE days < CASE WHEN daytype='weekend' THEN 2 ELSE 5 END)::int AS warmup,
        count(*)::int AS total
      FROM baseline`),
    db.query(`SELECT count(*)::int AS n FROM rollup_run WHERE bucket_ts >= now() - interval '24 hours'`),
    db.query(`SELECT payload->>'what' AS what FROM signal
              WHERE detector = 'data_health' AND ts >= now() - interval '24 hours' ORDER BY ts`),
    db.query(`SELECT s.payload, a.narrative, a.disposition, a.sources, a.confidence
              FROM signal s LEFT JOIN assessment a ON a.signal_id = s.id
              WHERE s.severity = 'S1' AND s.ts >= now() - interval '24 hours' ORDER BY s.ts`),
    db.query(`SELECT s.payload, a.narrative, a.disposition, a.sources, a.confidence
              FROM signal s LEFT JOIN assessment a ON a.signal_id = s.id
              WHERE s.severity = 'S2' AND s.ts >= now() - interval '24 hours'
              ORDER BY s.ts DESC LIMIT ${S2_DETAIL_CAP}`),
    db.query(`SELECT detector, count(*)::int AS n FROM signal
              WHERE severity = 'S2' AND ts >= now() - interval '24 hours' GROUP BY detector`),
    db.query(`SELECT count(*)::int AS n,
                     (array_agg(payload->>'what' ORDER BY ts DESC))[1:10] AS sample
              FROM signal WHERE severity = 'S3' AND detector != 'data_health'
                AND ts >= now() - interval '24 hours'`),
  ]);
  const binRow = bins.rows[0];
  return {
    generatedAt: new Date().toISOString(),
    periodHours: 24,
    warmup: {
      rollupDays: rollupDays.rows[0].d,
      bins: {
        mature: binRow.mature,
        partial: binRow.total - binRow.mature - binRow.warmup,
        warmup: binRow.warmup,
      },
    },
    dataHealth: {
      bucketsExpected: 288,
      bucketsPresent: buckets.rows[0].n,
      coverageIncidents: incidents.rows.map((r) => r.what),
    },
    signals: {
      s1: s1.rows,
      s2: s2.rows,
      s2Count: s2Counts.rows.reduce((sum, r) => sum + r.n, 0),
      s2ByDetector: Object.fromEntries(s2Counts.rows.map((r) => [r.detector, r.n])),
      s3Count: s3.rows[0]?.n ?? 0,
      s3Sample: s3.rows[0]?.sample ?? [],
    },
  };
}

export async function appendShadowWeek(db: Queryable, input: BriefingInput): Promise<void> {
  const { rows } = await db.query(
    `SELECT ts, signal, assessment, would_send FROM shadow_push
     WHERE ts >= now() - interval '7 days' ORDER BY ts`,
  );
  input.shadowWeek = rows;
}

export function buildBriefingPrompt(input: BriefingInput): string {
  const shadowNote = input.shadowWeek
    ? `\nIt is Sunday: the input includes shadowWeek — every signal that WOULD have pushed this week (push is still in shadow mode). Add a short "shadow log review" section: for each entry, one line on whether being interrupted for it would have been worth it. If the list is empty, one dry sentence acknowledging a quiet week for the pager that does not exist yet.`
    : '';
  return `Write today's briefing from this structured summary. The instrument watches global flight data only. signals.s2 carries only the most recent entries in full detail; signals.s2Count and s2ByDetector are the complete 24h totals — trust the counts for volume.${shadowNote}\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
}

const BREAKER_BODY =
  'Briefing unavailable — the monthly analyst spend cap has been reached. The instrument is still collecting; the analyst returns at the start of next month or when the cap is raised.';

export async function generateBriefing(
  db: Queryable,
  client: AnalystClient,
  opts: { dryRunInput?: BriefingInput } = {},
): Promise<{ body: string; quiet: boolean; persisted: boolean }> {
  const isDryRun = opts.dryRunInput !== undefined;
  const input = opts.dryRunInput ?? (await assembleBriefingInput(db));

  if (!isDryRun) {
    const isSundayLocal =
      new Intl.DateTimeFormat('en-US', { timeZone: env.briefingTimezone, weekday: 'short' })
        .format(new Date()) === 'Sun';
    if (isSundayLocal) await appendShadowWeek(db, input);
  }

  let body: string;
  const quiet =
    input.signals.s1.length === 0 &&
    input.signals.s2Count === 0 &&
    input.dataHealth.coverageIncidents.length === 0;

  if (await client.breakerTripped()) {
    body = BREAKER_BODY;
  } else {
    const result = await client.call('briefing', {
      model: env.briefingModel,
      // claude-sonnet-5 runs adaptive thinking by default and max_tokens caps
      // thinking + text COMBINED — at 1200 the thinking ate the budget and the
      // briefing truncated mid-sentence (2026-07-20, DECISIONS #93). Headroom
      // is cheap: the call stops at end_turn, so this is a ceiling not a spend.
      max_tokens: 8192,
      system: BRIEFING_SYSTEM,
      messages: [{ role: 'user', content: buildBriefingPrompt(input) }],
    });
    body = result.content
      .filter((b): b is Extract<(typeof result.content)[number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!body) throw new Error('briefing came back empty');
  }

  if (isDryRun) return { body, quiet, persisted: false };

  const dateLocal = new Intl.DateTimeFormat('en-CA', { timeZone: env.briefingTimezone }).format(new Date());
  await db.query(
    `INSERT INTO briefing (id, date_local, ts, body_md, quiet, model)
     VALUES ($1, $2, now(), $3, $4, $5)
     ON CONFLICT (date_local) DO UPDATE SET body_md = EXCLUDED.body_md, ts = EXCLUDED.ts, quiet = EXCLUDED.quiet`,
    [ulid(), dateLocal, body, quiet, env.briefingModel],
  );
  log('briefing', 'filed', { dateLocal, quiet, chars: body.length });
  return { body, quiet, persisted: true };
}
