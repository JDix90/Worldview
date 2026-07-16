/**
 * D3 — GPS interference (FOUNDATION §7). Fraction of aircraft with degraded
 * navigation integrity (NIC ≤ 4) per watch region, vs that region's OWN
 * recent norm — interference is chronic in these corridors (the Baltic idles
 * at ~40%), so absolute thresholds would either scream constantly or never.
 * Pure function; the job layer does all I/O.
 *
 * History comes from integrity_rollup (written by the sweep job). Region
 * maturity is simple day-count: <3 days observed → stay quiet (warmup),
 * <10 → partial, ≥10 → mature.
 */
import type { BaselineMaturity, Severity } from '@orrery/shared';

export interface RegionSample {
  regionId: string;
  name: string;
  /** Observation timestamp of the sweep being evaluated. */
  fetchedAt: number;
  /** Aircraft carrying NIC data in this sweep. */
  aircraft: number;
  /** Of those, NIC ≤ 4. */
  lowNic: number;
}

export interface RegionHistoryStats {
  /** Median low-NIC fraction over the trailing window. */
  medianFraction: number;
  /** Distinct days of history behind that median. */
  days: number;
}

export interface D3Input {
  nowS: number;
  samples: RegionSample[];
  history: Record<string, RegionHistoryStats>;
}

interface TrackedRegion {
  breaches: number;
  lastDataS: number;
  lastS: number;
}

export interface D3State {
  entries: Record<string, TrackedRegion>;
}

export interface D3Event {
  kind: 'gps_interference';
  severity: Severity;
  regionId: string;
  fraction: number;
  medianFraction: number;
  aircraft: number;
  maturity: BaselineMaturity;
  breaches: number;
  confidence: number;
  what: string;
  dedupeKey: string;
}

const MIN_AIRCRAFT = 20;
/** Fire only above ALL of: 2× the region's norm, norm + 15pts, and 25% absolute. */
const RATIO = 2;
const MARGIN = 0.15;
const FLOOR = 0.25;
const MIN_BREACHES = 2;
const WARMUP_DAYS = 3;
const MATURE_DAYS = 10;
const CONSECUTIVE_GAP_S = 400; // sweeps land every ~2 min
const ENTRY_TTL_S = 1200;

export function detectGpsInterference(
  input: D3Input,
  state: D3State,
): { events: D3Event[]; state: D3State } {
  const entries = { ...state.entries };
  const events: D3Event[] = [];

  for (const s of input.samples) {
    const hist = input.history[s.regionId];
    if (!hist || hist.days < WARMUP_DAYS) continue; // still learning this region's normal
    if (s.aircraft < MIN_AIRCRAFT) continue;

    const fraction = s.lowNic / s.aircraft;
    const threshold = Math.max(hist.medianFraction * RATIO, hist.medianFraction + MARGIN, FLOOR);
    const breaching = fraction >= threshold;

    if (!breaching) {
      delete entries[s.regionId];
      continue;
    }

    const prev = entries[s.regionId];
    const consecutive = prev !== undefined && input.nowS - prev.lastS <= CONSECUTIVE_GAP_S;
    const newObservation = !consecutive || s.fetchedAt > prev.lastDataS;
    const breaches = consecutive ? prev.breaches + (newObservation ? 1 : 0) : 1;
    entries[s.regionId] = {
      breaches,
      lastDataS: Math.max(prev?.lastDataS ?? 0, s.fetchedAt),
      lastS: input.nowS,
    };

    if (breaches < MIN_BREACHES) continue;

    const maturity: BaselineMaturity = hist.days >= MATURE_DAYS ? 'mature' : 'partial';
    const pct = Math.round(fraction * 100);
    const normPct = Math.round(hist.medianFraction * 100);
    const ratio = hist.medianFraction > 0 ? (fraction / hist.medianFraction).toFixed(1) : '∞';
    events.push({
      kind: 'gps_interference',
      severity: 'S2', // D3 never self-assigns S1 in Phase 1 — calibration first
      regionId: s.regionId,
      fraction,
      medianFraction: hist.medianFraction,
      aircraft: s.aircraft,
      maturity,
      breaches,
      confidence: Math.min(0.85, 0.55 + 0.05 * breaches + (maturity === 'mature' ? 0.1 : 0)),
      what: `Degraded navigation integrity on ${pct}% of ${s.aircraft} aircraft in ${s.name} — ${ratio}× this region's recent norm (${normPct}%), across ${breaches} consecutive sweeps.`,
      dedupeKey: `d3:gps:${s.regionId}`,
    });
  }

  for (const [id, e] of Object.entries(entries)) {
    if (input.nowS - e.lastS > ENTRY_TTL_S) delete entries[id];
  }

  return { events, state: { entries } };
}
