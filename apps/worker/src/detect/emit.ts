/**
 * Signal emission: dedupe latch, the S1 rolling-24h cap, and persistence
 * (Postgres row + Redis stream for the analyst).
 *
 * Cap semantics (FOUNDATION §4, DECISIONS #12): first-fired keeps S1; once 3
 * S1s exist in the rolling 24h, later ones demote to S2 with `demoted_from`
 * recorded. decideSeverity is pure for the verify script.
 */
import type { Redis } from 'ioredis';
import { REDIS_KEYS, ulid, type Severity, type Signal } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { log } from '../log.js';

const DEDUPE_TTL_S = 1800;
const S1_CAP = 3;
const S1_WINDOW_MS = 24 * 3600_000;

export function decideSeverity(
  requested: Severity,
  recentS1TimestampsMs: number[],
  nowMs: number,
): { severity: Severity; demoted_from?: 'S1' } {
  if (requested !== 'S1') return { severity: requested };
  const inWindow = recentS1TimestampsMs.filter((t) => nowMs - t < S1_WINDOW_MS);
  if (inWindow.length >= S1_CAP) return { severity: 'S2', demoted_from: 'S1' };
  return { severity: 'S1' };
}

export type EmitOutcome = 'emitted' | 'suppressed_active';

export class SignalEmitter {
  constructor(
    private redis: Redis,
    private db: Queryable,
  ) {}

  /** Emit unless this dedupe key already has an active (unexpired) signal. */
  async emit(draft: Omit<Signal, 'id' | 'ts' | 'demoted_from'>): Promise<EmitOutcome> {
    const latchKey = REDIS_KEYS.signalActive(draft.dedupe_key);
    const fresh = await this.redis.set(latchKey, '1', 'EX', DEDUPE_TTL_S, 'NX');
    if (fresh === null) {
      // condition persists — keep the latch warm, emit nothing new
      await this.redis.expire(latchKey, DEDUPE_TTL_S);
      return 'suppressed_active';
    }

    const nowMs = Date.now();
    let severity = draft.severity;
    let demotedFrom: 'S1' | undefined;
    if (draft.severity === 'S1') {
      await this.redis.zremrangebyscore(REDIS_KEYS.s1CapZset, 0, nowMs - S1_WINDOW_MS);
      const recent = await this.redis.zrange(REDIS_KEYS.s1CapZset, 0, -1, 'WITHSCORES');
      const scores = recent.filter((_, i) => i % 2 === 1).map(Number);
      const decision = decideSeverity('S1', scores, nowMs);
      severity = decision.severity;
      demotedFrom = decision.demoted_from;
      if (severity === 'S1') {
        await this.redis.zadd(REDIS_KEYS.s1CapZset, nowMs, `${draft.dedupe_key}:${nowMs}`);
      }
    }

    const signal: Signal = {
      ...draft,
      severity,
      ...(demotedFrom ? { demoted_from: demotedFrom } : {}),
      id: ulid(nowMs),
      ts: new Date(nowMs).toISOString(),
    };

    await this.db.query(
      `INSERT INTO signal (id, ts, source, detector, severity, demoted_from, dedupe_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [signal.id, signal.ts, signal.source, signal.detector, signal.severity,
       signal.demoted_from ?? null, signal.dedupe_key, JSON.stringify(signal)],
    );
    await this.redis.xadd(
      REDIS_KEYS.signalStream, 'MAXLEN', '~', '1000', '*', 'signal', JSON.stringify(signal),
    );
    log('signal', `${signal.severity} ${signal.detector}`, {
      id: signal.id,
      what: signal.what,
      ...(signal.demoted_from ? { demoted_from: signal.demoted_from } : {}),
    });
    return 'emitted';
  }
}
