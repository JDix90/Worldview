/**
 * Deterministic triage gating (2026-07-22, DECISIONS #109). The analyst was
 * spending ~4× the FOUNDATION §8 target because every S2 got a Haiku call —
 * including the same persisting condition re-fired every sweep. This module
 * decides, in code the way §2 demands, which signals are WORTH an LLM call:
 *
 *  - S1: always triaged, never capped. They are the product and are rare
 *    by design (<1/week bar).
 *  - S2: triaged only while the daily budget lasts, and only once per
 *    dedupe condition per cooldown window — a Baltic jamming flag at 14:00
 *    does not need a fresh narrative at 14:02.
 *
 * Skipped S2s still land in Postgres/feed with full detector context; they
 * simply carry no analyst narrative. Pure function; Redis plumbing in jobs.ts.
 */
import type { Signal } from '@orrery/shared';

/** Once triaged, the same dedupe condition is not re-triaged for this long. */
export const TRIAGE_COOLDOWN_S = 6 * 3600;

export interface TriageDecision {
  triage: boolean;
  reason: 'S1' | 'ok' | 'daily_cap' | 'cooldown' | 'not_triageable';
}

export function decideTriage(
  signal: Pick<Signal, 'severity' | 'dedupe_key'>,
  opts: {
    /** Triage calls already made today (Redis daily counter). */
    usedToday: number;
    /** Daily S2 triage budget (env.triagePerDay). */
    dailyCap: number;
    /** True when this dedupe_key was triaged within TRIAGE_COOLDOWN_S. */
    onCooldown: boolean;
  },
): TriageDecision {
  if (signal.severity === 'S1') return { triage: true, reason: 'S1' };
  if (signal.severity !== 'S2') return { triage: false, reason: 'not_triageable' };
  if (opts.onCooldown) return { triage: false, reason: 'cooldown' };
  if (opts.usedToday >= opts.dailyCap) return { triage: false, reason: 'daily_cap' };
  return { triage: true, reason: 'ok' };
}
