/**
 * The Signal schema — the only thing Stage 3 (detectors) may emit, and the
 * only operational data Stage 4 (analyst) may see. Spec: FOUNDATION.md §6.
 * Changing this shape is a FOUNDATION amendment, not a refactor.
 */

export type Severity = 'S1' | 'S2' | 'S3';

export type DetectorId =
  | 'data_health'
  | 'traffic_collapse'
  | 'emergency_squawk'
  | 'gps_interference';

export type BaselineMaturity = 'warmup' | 'partial' | 'mature' | 'n/a';

export interface Signal {
  id: string;
  ts: string;
  source: 'flights';
  detector: DetectorId;
  severity: Severity;
  demoted_from?: 'S1';

  what: string;
  where: {
    region: string;
    lat: number;
    lon: number;
    radius_km?: number;
    cells?: string[];
  };
  magnitude: {
    metric: string;
    observed: number;
    baseline: number;
    deviation: number;
  };
  confidence: number;
  baseline_maturity: BaselineMaturity;
  data_health: {
    coverage_ok: boolean;
    global_count_delta_pct: number;
  };
  evidence: {
    window_start: string;
    window_end: string;
    aircraft_count?: number;
    sample_hexes?: string[];
  };
  dedupe_key: string;
}

/** Stage 4 output. severity_final may only be ≤ the signal's severity. */
export interface Assessment {
  signal_id: string;
  disposition: 'explained' | 'unexplained' | 'noise';
  severity_final: Severity;
  narrative: string;
  sources_consulted: string[];
  confidence: number;
}
