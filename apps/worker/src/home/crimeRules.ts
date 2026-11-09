/**
 * Crime rules for the home briefing (FOUNDATION §12, DECISIONS #143–144).
 * Pure functions shared by the live detector (crime.ts) and the backtest
 * (scripts/backtestHomeBriefing.ts), so the rules that were measured are the
 * rules that run.
 */

export type CrimeGroup = 'violent' | 'property' | 'other';

// Grouping mirrors apps/web/src/feed/crime.ts (DECISIONS #113).
export const VIOLENT = new Set(['murder', 'robbery', 'aggravated-assault', 'other-crimes-against-persons', 'sexual-assault']);
export const PROPERTY = new Set(['burglary', 'larceny', 'theft-from-motor-vehicle', 'auto-theft', 'arson']);
/** VIOLENT minus other-crimes-against-persons (in the backtest window, mostly
 *  simple assault: 230 of ~270 within 1 mi). */
export const SERIOUS = new Set(['murder', 'robbery', 'aggravated-assault', 'sexual-assault']);
/** Offense types meaning a gun was fired or someone was killed, including
 *  shots fired with no one hit (`weapon-unlawful-discharge-of`). */
export const GUNFIRE = /shoot|homicide|murder|weapon-fire|discharge/;

/** The owner's walking radius. Every gunfire and serious violent offense
 *  inside it goes in the morning note (DECISIONS #144). */
export const WALK_RADIUS_MI = 1;
/** Ring for change-against-normal counts (#143 b). */
export const CLUSTER_RADIUS_MI = 0.5;
/** How long after its reported date an offense still counts as news. Denver
 *  publishes Mon–Fri with a lag of a day or two, so Monday carries the
 *  weekend; a week covers holidays without re-reporting (events dedupe). */
export const NEWS_LOOKBACK_DAYS = 7;

export function groupOf(category: string): CrimeGroup {
  if (VIOLENT.has(category)) return 'violent';
  if (PROPERTY.has(category)) return 'property';
  return 'other';
}

export type NearbyRule = 'crime.gunfire' | 'crime.violent';

/** The per-incident rule an offense meets at this distance from home, if
 *  any. Gunfire wins over violent, so one offense makes one line. */
export function nearbyRule(o: { category: string; type: string }, distanceMi: number): NearbyRule | null {
  if (!(distanceMi <= WALK_RADIUS_MI)) return null;
  if (GUNFIRE.test(o.type) || o.category === 'murder') return 'crime.gunfire';
  if (SERIOUS.has(o.category)) return 'crime.violent';
  return null;
}

/** Cluster series an offense counts toward. */
export function clusterKeys(category: string): string[] {
  const keys = [category];
  if (PROPERTY.has(category)) keys.push('all property crime');
  if (VIOLENT.has(category)) keys.push('all violent crime');
  return keys;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface ClusterLevels {
  median: number;
  sigma: number;
  /** Fire at or above this 7-day count. */
  alertAt: number;
  /** Re-arm once the count is back at or below this. */
  rearmAt: number;
}

/** The "normal" for a 7-day count: median and MAD-derived σ over the history
 *  (FOUNDATION §2: robust, so one bad week doesn't move it). Needs ~half a
 *  year of history before it will call anything unusual. */
export function clusterLevels(history: number[]): ClusterLevels | null {
  if (history.length < 180) return null;
  const m = median(history);
  const sigma = 1.4826 * median(history.map((v) => Math.abs(v - m)));
  return {
    median: m,
    sigma,
    alertAt: Math.max(3, m + Math.max(3, 3 * sigma)),
    rearmAt: Math.max(m + 1.5 * sigma, m + 1),
  };
}

/** Trailing 7-day sums of a daily series (NaN until 7 days exist). */
export function trailing7(daily: number[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < daily.length; i++) {
    sum += daily[i]!;
    if (i >= 7) sum -= daily[i - 7]!;
    out.push(i < 6 ? NaN : sum);
  }
  return out;
}

export interface ClusterStep {
  fire: boolean;
  armed: boolean;
  count: number;
  levels: ClusterLevels;
}

/** One day of the cluster detector: compare day i's 7-day count with the
 *  prior year's (excluding the overlapping week), fire on the first crossing,
 *  stay latched until it is back near normal. null while history is short. */
export function stepCluster(t7: number[], i: number, armed: boolean): ClusterStep | null {
  const history = t7.slice(Math.max(6, i - 371), i - 6).filter(Number.isFinite);
  const levels = clusterLevels(history);
  const count = t7[i];
  if (!levels || count === undefined || !Number.isFinite(count)) return null;
  if (armed && count >= levels.alertAt) return { fire: true, armed: false, count, levels };
  if (!armed && count <= levels.rearmAt) return { fire: false, armed: true, count, levels };
  return { fire: false, armed, count, levels };
}

// ── local days (America/Denver) ───────────────────────────────────────────
const TZ = 'America/Denver';
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in Denver time. */
export const localDay = (ms: number): string => fmtDay.format(ms);
export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export function daysBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}
