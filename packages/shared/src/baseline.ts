/**
 * Baseline semantics shared by the worker (computes), server (serves), and
 * detectors (consume). Bins are cell × UTC-hour × daytype; statistics are
 * median/MAD over a rolling 28-day window (DECISIONS.md #5).
 */
import type { BaselineMaturity } from './signal.js';

export type Daytype = 'weekday' | 'weekend';

export const BASELINE_WINDOW_DAYS = 28;

export function daytypeOf(d: Date): Daytype {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
}

/**
 * Maturity from distinct days observed, as a fraction of the days that COULD
 * appear in the window (20 weekdays / 8 weekend days per 28) — absolute
 * thresholds would leave weekend bins in permanent warmup.
 *   <25% → warmup, <75% → partial, ≥75% → mature
 */
export function maturityOf(daysObserved: number, daytype: Daytype): BaselineMaturity {
  const max = daytype === 'weekend' ? 8 : 20;
  const frac = daysObserved / max;
  if (frac < 0.25) return 'warmup';
  if (frac < 0.75) return 'partial';
  return 'mature';
}

export interface BaselineEntry {
  cell: string;
  hour: number;
  daytype: Daytype;
  median: number;
  mad: number;
  samples: number;
  days: number;
  maturity: BaselineMaturity;
}
