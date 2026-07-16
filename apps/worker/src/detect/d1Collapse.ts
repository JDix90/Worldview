/**
 * D1 — regional traffic collapse (FOUNDATION §7). Density per 5° cell vs its
 * own median/MAD baseline for the current hour × daytype. Pure function; the
 * job layer does all I/O.
 *
 * Guards, in order of importance:
 *  - runs only when D0 says coverage is OK (receiver dropout is this
 *    detector's #1 false-positive source) — breach counts freeze, not reset,
 *    across a coverage blip;
 *  - baseline maturity must be ≥ partial, and the cell's median ≥ 20 aircraft
 *    (a "collapse" in a 3-plane cell is noise);
 *  - MAD gets a Poisson-ish floor (max(mad, √median, 1)) so quiet-but-steady
 *    cells can't produce infinite z-scores;
 *  - persistence counts strictly-advancing snapshot timestamps, never detect
 *    cycles (the D2 lesson, DECISIONS #42).
 */
import { maturityOf, type BaselineMaturity, type Daytype, type Severity } from '@orrery/shared';

export interface CellBaseline {
  median: number;
  mad: number;
  days: number;
  daytype: Daytype;
}

export interface D1Input {
  nowS: number;
  /** Observation timestamp of the snapshot being evaluated. */
  snapshotFetchedAt: number;
  /** Airborne aircraft per cell id, from the current snapshot. */
  cellCounts: Record<string, number>;
  /** Baselines for the current hour × daytype, keyed by cell. */
  baselines: Record<string, CellBaseline>;
  coverageOk: boolean;
}

interface TrackedCell {
  /** Count of independent breaching observations (advancing fetchedAt). */
  breaches: number;
  lastDataS: number;
  lastS: number;
}

export interface D1State {
  entries: Record<string, TrackedCell>;
}

export interface D1Event {
  kind: 'traffic_collapse';
  severity: Severity;
  cell: string;
  observed: number;
  median: number;
  /** Robust z — (observed − median) / max(mad, √median, 1). */
  deviation: number;
  dropFraction: number;
  maturity: BaselineMaturity;
  breaches: number;
  confidence: number;
  what: string;
  dedupeKey: string;
}

const MIN_CELL_MEDIAN = 20;
const DROP_FRACTION = 0.4;
const Z_THRESHOLD = -3;
const MIN_BREACHES = 2;
/** Escalation: this is "half of Europe went dark", not "a quiet evening". */
const S1_DROP = 0.6;
const S1_MEDIAN = 50;
const S1_BREACHES = 3;
const CONSECUTIVE_GAP_S = 150;
const ENTRY_TTL_S = 600;

export function detectCollapse(
  input: D1Input,
  state: D1State,
): { events: D1Event[]; state: D1State } {
  const entries = { ...state.entries };

  // coverage not OK → freeze: no evaluation, no resets. A receiver blip must
  // neither fire this detector nor erase legitimate persistence progress.
  if (!input.coverageOk) {
    return { events: [], state: { entries } };
  }

  const events: D1Event[] = [];

  for (const [cell, base] of Object.entries(input.baselines)) {
    const maturity = maturityOf(base.days, base.daytype);
    if (maturity === 'warmup') continue;
    if (base.median < MIN_CELL_MEDIAN) continue;

    const observed = input.cellCounts[cell] ?? 0;
    const effMad = Math.max(base.mad, Math.sqrt(base.median), 1);
    const z = (observed - base.median) / effMad;
    const drop = 1 - observed / base.median;
    const breaching = drop >= DROP_FRACTION && z <= Z_THRESHOLD;

    if (!breaching) {
      delete entries[cell];
      continue;
    }

    const prev = entries[cell];
    const consecutive = prev !== undefined && input.nowS - prev.lastS <= CONSECUTIVE_GAP_S;
    const newObservation = !consecutive || input.snapshotFetchedAt > prev.lastDataS;
    const breaches = consecutive ? prev.breaches + (newObservation ? 1 : 0) : 1;
    entries[cell] = {
      breaches,
      lastDataS: Math.max(prev?.lastDataS ?? 0, input.snapshotFetchedAt),
      lastS: input.nowS,
    };

    if (breaches < MIN_BREACHES) continue;

    const severity: Severity =
      drop >= S1_DROP && base.median >= S1_MEDIAN && breaches >= S1_BREACHES ? 'S1' : 'S2';
    const dropPct = Math.round(drop * 100);
    events.push({
      kind: 'traffic_collapse',
      severity,
      cell,
      observed,
      median: base.median,
      deviation: Math.round(z * 10) / 10,
      dropFraction: drop,
      maturity,
      breaches,
      confidence: Math.min(0.9, 0.5 + 0.1 * breaches + (maturity === 'mature' ? 0.1 : 0)),
      what: `Traffic over ${cell} down ${dropPct}% against baseline (${observed} aircraft vs median ${Math.round(base.median)}) across ${breaches} consecutive observations.`,
      dedupeKey: `d1:collapse:${cell}`,
    });
  }

  for (const [cell, e] of Object.entries(entries)) {
    if (input.nowS - e.lastS > ENTRY_TTL_S) delete entries[cell];
  }

  return { events, state: { entries } };
}
