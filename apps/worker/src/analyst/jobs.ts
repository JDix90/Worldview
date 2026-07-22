/**
 * Analyst jobs. jobAnalystPoll consumes the signal stream (cursor in Redis,
 * at-least-once with idempotent assessment writes) and triages S1/S2.
 * Confirmed-S1 outcomes always land in the shadow log; pushAnomaly decides
 * whether anything actually leaves the machine (it doesn't, in shadow mode).
 * jobBriefing files the daily briefing; jobOpsWatch alerts on a dead collector.
 */
import type { Redis } from 'ioredis';
import { REDIS_KEYS, ulid, type Assessment, type Signal } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { env } from '../env.js';
import { log, logError } from '../log.js';
import { AnalystClient } from './client.js';
import { buildTriagePrompt, parseAssessment, webSearchTool, TRIAGE_SYSTEM } from './triage.js';
import { generateBriefing } from './briefing.js';
import { decideTriage, TRIAGE_COOLDOWN_S } from './triagePolicy.js';
import { pushAnomaly, pushOps } from './notify.js';

const CURSOR_KEY = 'analyst:stream:cursor';
const SEARCH_BUDGET_KEY = (day: string) => `analyst:websearch:${day}`;
const TRIAGE_BUDGET_KEY = (day: string) => `analyst:triage:${day}`;
const TRIAGE_COOLDOWN_KEY = (dedupe: string) => `analyst:triaged:${dedupe}`;

async function remainingSearchBudget(redis: Redis): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const used = Number((await redis.get(SEARCH_BUDGET_KEY(day))) ?? 0);
  return Math.max(0, env.webSearchesPerDay - used);
}

async function consumeSearchBudget(redis: Redis, n: number): Promise<void> {
  if (n <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = SEARCH_BUDGET_KEY(day);
  await redis.incrby(key, n);
  await redis.expire(key, 2 * 86400);
}

/** Untriaged S1s MUST reach the shadow log (FOUNDATION §4) — whether the
 *  analyst is unconfigured OR a call failed mid-flight. One shared writer. */
async function shadowLogUntriaged(db: Queryable, signal: Signal, why: string): Promise<void> {
  const wouldSend = `ORRERY S1 — ${signal.detector}\n${signal.what}\n(untriaged: ${why})`;
  await db.query(
    `INSERT INTO shadow_push (id, ts, signal_id, signal, assessment, would_send, pushed)
     VALUES ($1, now(), $2, $3, NULL, $4, false)
     ON CONFLICT DO NOTHING`,
    [ulid(), signal.id, JSON.stringify(signal), wouldSend],
  );
  log('analyst', 'S1 → shadow log (untriaged)', { signal: signal.id, why });
}

export async function triageSignal(
  db: Queryable,
  redis: Redis,
  client: AnalystClient,
  signal: Signal,
): Promise<Assessment | null> {
  if (await client.breakerTripped()) {
    log('analyst', 'breaker tripped — triage skipped', { signal: signal.id });
    return null;
  }
  const budget = await remainingSearchBudget(redis);
  const result = await client.call('triage', {
    model: env.triageModel,
    max_tokens: 1000,
    system: TRIAGE_SYSTEM,
    messages: [{ role: 'user', content: buildTriagePrompt(signal) }],
    ...(budget > 0 ? { tools: [webSearchTool(Math.min(budget, 3))] } : {}),
  });
  await consumeSearchBudget(redis, result.webSearches);

  const assessment = parseAssessment(result.content, signal, env.triageModel);
  await db.query(
    `INSERT INTO assessment (signal_id, ts, disposition, severity_final, narrative, sources, confidence, model)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7)
     ON CONFLICT (signal_id) DO NOTHING`,
    [assessment.signal_id, assessment.disposition, assessment.severity_final,
     assessment.narrative, JSON.stringify(assessment.sources_consulted),
     assessment.confidence, env.triageModel],
  );
  return assessment;
}

export async function jobAnalystPoll(redis: Redis, db: Queryable): Promise<void> {
  const client = new AnalystClient(db);
  const cursor = (await redis.get(CURSOR_KEY)) ?? '0';
  const entries = await redis.xrange(REDIS_KEYS.signalStream, `(${cursor}`, '+', 'COUNT', 20);

  for (const [id, fields] of entries) {
    const idx = fields.indexOf('signal');
    if (idx >= 0 && fields[idx + 1]) {
      const signal = JSON.parse(fields[idx + 1]!) as Signal;
      try {
        if (signal.severity === 'S1' || signal.severity === 'S2') {
          if (!client.configured) {
            log('analyst', 'no API key — signal recorded, triage skipped', { signal: signal.id });
            // no analyst means no downgrade: an S1 stands and MUST reach the
            // shadow log, or the calibration review has a blind spot
            if (signal.severity === 'S1') await shadowLogUntriaged(db, signal, 'analyst unavailable');
          } else {
            // Deterministic gate (DECISIONS #109): S1 always; S2 only within
            // the daily budget and once per condition per cooldown window.
            const day = new Date().toISOString().slice(0, 10);
            const decision = decideTriage(signal, {
              usedToday: Number((await redis.get(TRIAGE_BUDGET_KEY(day))) ?? 0),
              dailyCap: env.triagePerDay,
              onCooldown: (await redis.exists(TRIAGE_COOLDOWN_KEY(signal.dedupe_key))) === 1,
            });
            if (!decision.triage) {
              log('analyst', `triage skipped (${decision.reason})`, { signal: signal.id, severity: signal.severity });
            } else {
              if (signal.severity === 'S2') {
                const budgetKey = TRIAGE_BUDGET_KEY(day);
                await redis.incr(budgetKey);
                await redis.expire(budgetKey, 2 * 86400);
              }
              await redis.set(TRIAGE_COOLDOWN_KEY(signal.dedupe_key), '1', 'EX', TRIAGE_COOLDOWN_S);
              const assessment = await triageSignal(db, redis, client, signal);
              // S1 that survives triage → shadow log (and push, iff the gate is open)
              if (signal.severity === 'S1' && assessment && assessment.severity_final === 'S1') {
                const title = `ORRERY S1 — ${signal.detector}`;
                const message = `${signal.what}\n${assessment.narrative}\n(confidence ${assessment.confidence})`;
                const pushed = await pushAnomaly(title, message);
                await db.query(
                  `INSERT INTO shadow_push (id, ts, signal_id, signal, assessment, would_send, pushed)
                   VALUES ($1, now(), $2, $3, $4, $5, $6)`,
                  [ulid(), signal.id, JSON.stringify(signal), JSON.stringify(assessment),
                   `${title}\n${message}`, pushed],
                );
                log('analyst', pushed ? 'S1 PUSHED' : 'S1 → shadow log', { signal: signal.id });
              }
            }
          }
        }
      } catch (err) {
        logError('analyst', `triage failed for ${signal.id}`, err);
        // A transient analyst failure must not cost the calibration review an
        // S1: no assessment means no downgrade, so the S1 stands — log it
        // untriaged exactly like the no-key path (fresh-eyes review HIGH-1).
        if (signal.severity === 'S1') {
          try {
            await shadowLogUntriaged(db, signal, 'analyst error');
          } catch (shadowErr) {
            logError('analyst', `shadow-log write failed for ${signal.id}`, shadowErr);
          }
        }
      }
    }
    await redis.set(CURSOR_KEY, id); // advance even on failure — no poison-pill loops
  }
}

export async function jobBriefing(db: Queryable): Promise<void> {
  const client = new AnalystClient(db);
  if (!client.configured) {
    log('briefing', 'no API key — briefing skipped');
    return;
  }
  await generateBriefing(db, client);
}

/**
 * Interval-scheduled guard around jobBriefing (DECISIONS #93): runs every 15
 * minutes; files the briefing once we're past the local briefing hour and
 * today's row doesn't exist yet. Catch-up by design — an appliance that was
 * powered off at 07:00 files late instead of never. Safe against races:
 * generateBriefing upserts ON CONFLICT (date_local).
 */
export async function jobBriefingCheck(db: Queryable): Promise<void> {
  const now = new Date();
  const hourLocal = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: env.briefingTimezone, hour: 'numeric', hour12: false }).format(now),
  );
  if (hourLocal < env.briefingHourLocal) return;
  // same formatter jobBriefing's insert uses — the guard must match the key
  const dateLocal = new Intl.DateTimeFormat('en-CA', { timeZone: env.briefingTimezone }).format(now);
  const { rows } = await db.query(`SELECT 1 FROM briefing WHERE date_local = $1`, [dateLocal]);
  if (rows.length > 0) return;
  log('briefing', 'daily briefing missing past the hour — filing now', { dateLocal, hourLocal });
  await jobBriefing(db);
}

/** Ops watch: a collector that has been silent >30 min is worth a real alert,
 *  and so is analyst spend closing in on the monthly breaker — the breaker
 *  tripping mid-soak silently darkens the briefing streak (DECISIONS #109). */
export async function jobOpsWatch(redis: Redis, db: Queryable): Promise<void> {
  const meta = await redis.hgetall(REDIS_KEYS.hotSnapshotMeta);
  const updatedAtMs = Number(meta.updatedAtMs ?? 0);
  const silentMin = (Date.now() - updatedAtMs) / 60000;
  if (updatedAtMs > 0 && silentMin > 30) {
    const latch = await redis.set('ops:collector-stale', '1', 'EX', 6 * 3600, 'NX');
    if (latch !== null) {
      await pushOps('ORRERY — collector silent', `No new snapshot for ${Math.round(silentMin)} minutes.`);
    }
  }

  const client = new AnalystClient(db);
  const mtd = await client.monthToDateUsd();
  if (mtd >= 0.7 * env.monthlySpendCapUsd) {
    const month = new Date().toISOString().slice(0, 7);
    const latch = await redis.set(`ops:spend-warn:${month}`, '1', 'EX', 35 * 86400, 'NX');
    if (latch !== null) {
      await pushOps(
        'ORRERY — analyst spend at 70% of cap',
        `$${mtd.toFixed(2)} of $${env.monthlySpendCapUsd} this month. At the cap the briefing degrades to "unavailable — spend cap".`,
      );
    }
  }
}
