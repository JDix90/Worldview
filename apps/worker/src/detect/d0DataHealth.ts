/**
 * D0 — data health (FOUNDATION §7). Runs before everything: the dominant
 * failure mode of receiver-network data is receivers going away, not the
 * world changing. Pure function; the job layer does all I/O.
 *
 * v1 conditions: snapshot staleness, and a correlated global count drop vs
 * the recent hour's median. Regional receiver-cluster loss (neighbor-cell
 * correlation) arrives with D1, which is what it exists to guard.
 */

export interface D0Input {
  nowS: number;
  /** 0 when no snapshot exists at all. */
  snapshotFetchedAt: number;
  totalAirborne: number;
  /** rollup_run totals from the last hour, oldest first. */
  recentTotals: Array<{ ts: number; total: number }>;
}

export interface D0Condition {
  kind: 'snapshot_stale' | 'global_count_drop';
  what: string;
  observed: number;
  reference: number;
}

export interface D0Result {
  coverageOk: boolean;
  /** Global airborne count vs recent median, percent (0 when no history). */
  globalDeltaPct: number;
  conditions: D0Condition[];
}

const STALE_AFTER_S = 300;
/** Need this many 5-min buckets before a drop verdict means anything. */
const MIN_HISTORY = 6;
/** Below this median the network is too small for percentage logic. */
const MIN_MEDIAN = 1000;
const DROP_FRACTION = 0.3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function detectDataHealth(input: D0Input): D0Result {
  const conditions: D0Condition[] = [];

  const ageS = input.snapshotFetchedAt > 0 ? input.nowS - input.snapshotFetchedAt : Infinity;
  if (ageS > STALE_AFTER_S) {
    conditions.push({
      kind: 'snapshot_stale',
      what:
        input.snapshotFetchedAt > 0
          ? `Global snapshot is ${Math.round(ageS / 60)} min old — collector or upstream is not delivering.`
          : 'No global snapshot exists in hot state.',
      observed: Number.isFinite(ageS) ? Math.round(ageS) : -1,
      reference: STALE_AFTER_S,
    });
  }

  let globalDeltaPct = 0;
  if (input.recentTotals.length >= MIN_HISTORY) {
    const m = median(input.recentTotals.map((r) => r.total));
    if (m >= MIN_MEDIAN) {
      globalDeltaPct = ((input.totalAirborne - m) / m) * 100;
      if (input.totalAirborne < m * (1 - DROP_FRACTION)) {
        conditions.push({
          kind: 'global_count_drop',
          what: `Global airborne count ${input.totalAirborne} is ${Math.round(-globalDeltaPct)}% below the last hour's median (${Math.round(m)}) — receiver-network loss suspected.`,
          observed: input.totalAirborne,
          reference: Math.round(m),
        });
      }
    }
  }

  return { coverageOk: conditions.length === 0, globalDeltaPct, conditions };
}
