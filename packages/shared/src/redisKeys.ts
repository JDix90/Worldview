/**
 * Redis key registry — worker writes, server reads. One place so the two
 * processes can't drift.
 */

export const REDIS_KEYS = {
  /** Latest normalized GlobalSnapshot, JSON. */
  hotSnapshot: 'hot:snapshot',
  /** Hash: fetchedAt, count, creditsRemaining, updatedAtMs. */
  hotSnapshotMeta: 'hot:snapshot:meta',
  /** Latest aircraft squawking the given code, JSON {fetchedAt, aircraft}. */
  hotSquawk: (code: string) => `hot:squawk:${code}`,
  /** Latest integrity sweep for a watch region, JSON {fetchedAt, aircraft}. */
  hotIntegrity: (regionId: string) => `hot:integrity:${regionId}`,
  /** Daily OpenSky credit spend counter (our own accounting). */
  openskyCredits: (isoDate: string) => `credits:opensky:${isoDate}`,
  /** '1'/'0' — D0's verdict this cycle; baseline-dependent detectors must respect it. */
  healthCoverageOk: 'health:coverage_ok',
  /** D1's per-cell collapse-persistence state, JSON. */
  detectStateD1: 'detect:state:d1',
  /** D2's persistent squawk-tracking state, JSON. */
  detectStateD2: 'detect:state:d2',
  /** D3's per-region interference-persistence state, JSON. */
  detectStateD3: 'detect:state:d3',
  /** Stream of emitted Signals (XADD), consumed by the analyst in chunk 6. */
  signalStream: 'signals:stream',
  /** ZSET of S1 emission timestamps for the rolling-24h push cap. */
  s1CapZset: 's1:emitted',
  /** Active-condition dedupe latch; existence suppresses re-emission. */
  signalActive: (dedupeKey: string) => `signal:active:${dedupeKey}`,
} as const;

export const EMERGENCY_SQUAWKS = ['7500', '7600', '7700'] as const;
