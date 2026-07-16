/**
 * Snapshot diffing for the WebSocket feed. Pure — exercised directly by
 * scripts/verifyDelta.ts.
 */
import type { AircraftState } from '@orrery/shared';

export interface SnapshotDelta {
  upsert: AircraftState[];
  remove: string[];
}

/**
 * Fields whose change makes an aircraft worth re-sending. Everything the
 * client renders or shows on the card; deliberately not deep-equality so a
 * no-op re-poll of a parked aircraft sends nothing.
 */
function changed(a: AircraftState, b: AircraftState): boolean {
  return (
    a.seenAt !== b.seenAt ||
    a.lat !== b.lat ||
    a.lon !== b.lon ||
    a.altBaroM !== b.altBaroM ||
    a.groundSpeedMs !== b.groundSpeedMs ||
    a.trackDeg !== b.trackDeg ||
    a.verticalRateMs !== b.verticalRateMs ||
    a.squawk !== b.squawk ||
    a.onGround !== b.onGround ||
    a.callsign !== b.callsign
  );
}

export function computeDelta(
  prev: ReadonlyMap<string, AircraftState>,
  next: AircraftState[],
): SnapshotDelta {
  const upsert: AircraftState[] = [];
  const seen = new Set<string>();
  for (const a of next) {
    seen.add(a.hex);
    const before = prev.get(a.hex);
    if (!before || changed(before, a)) upsert.push(a);
  }
  const remove: string[] = [];
  for (const hex of prev.keys()) {
    if (!seen.has(hex)) remove.push(hex);
  }
  return { upsert, remove };
}
