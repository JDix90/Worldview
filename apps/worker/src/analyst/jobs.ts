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
import { pushAnomaly, pushOps } from './notify.js';

const CURSOR_KEY = 'analyst:stream:cursor';
const SEARCH_BUDGET_KEY = (day: string) => `analyst:websearch:${day}`;

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
            if (signal.severity === 'S1') {
              const wouldSend = `ORRERY S1 — ${signal.detector}\n${signal.what}\n(untriaged: analyst unavailable)`;
              await db.query(
                `INSERT INTO shadow_push (id, ts, signal_id, signal, assessment, would_send, pushed)
                 VALUES ($1, now(), $2, $3, NULL, $4, false)`,
                [ulid(), signal.id, JSON.stringify(signal), wouldSend],
              );
              log('analyst', 'S1 → shadow log (untriaged)', { signal: signal.id });
            }
          } else {
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
      } catch (err) {
        logError('analyst', `triage failed for ${signal.id}`, err);
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

/** Ops watch: a collector that has been silent >30 min is worth a real alert. */
export async function jobOpsWatch(redis: Redis): Promise<void> {
  const meta = await redis.hgetall(REDIS_KEYS.hotSnapshotMeta);
  const updatedAtMs = Number(meta.updatedAtMs ?? 0);
  const silentMin = (Date.now() - updatedAtMs) / 60000;
  if (updatedAtMs > 0 && silentMin > 30) {
    const latch = await redis.set('ops:collector-stale', '1', 'EX', 6 * 3600, 'NX');
    if (latch !== null) {
      await pushOps('ORRERY — collector silent', `No new snapshot for ${Math.round(silentMin)} minutes.`);
    }
  }
}
