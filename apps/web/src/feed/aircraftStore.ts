/**
 * Client-side aircraft state: applies snapshot/delta frames from the feed and
 * produces smooth per-frame render positions.
 *
 * Two-layer position model per aircraft:
 *  - target: dead-reckoned from the latest reported fix (velocity + track),
 *    recomputed every frame — where the aircraft "should" be right now
 *  - render: what's drawn; converges toward target exponentially, so a fresh
 *    poll bends the path over ~a second instead of teleporting the marker
 */
import type { AircraftState, WsDeltaMsg, WsSnapshotMsg } from '@orrery/shared';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;
/** Don't extrapolate a fix forever; beyond this the position freezes. */
const MAX_EXTRAPOLATION_S = 300;
/** Grace after the feed removes an aircraft — OpenSky coverage flickers. */
const REMOVE_GRACE_MS = 180_000;
/** Data this stale gets dropped outright. */
const MAX_AGE_MS = 360_000;
/** Convergence rate of render → target (per second). ~86% closed in 1s. */
const BLEND_RATE = 2.0;

export interface Tracked {
  state: AircraftState;
  receivedAtMs: number;
  missingSinceMs: number | null;
  renderLat: number;
  renderLon: number;
  renderAltM: number;
}

export interface FeedStats {
  total: number;
  rendered: number;
  fetchedAt: number;
  lastFrameMs: number;
}

/** Normalize a longitude difference into [-180, 180] (dateline-safe lerp). */
function lonDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export class AircraftStore {
  readonly byHex = new Map<string, Tracked>();
  private fetchedAt = 0;
  private lastFrameMs = 0;

  applySnapshot(msg: WsSnapshotMsg): void {
    const now = Date.now();
    const incoming = new Set<string>();
    for (const state of msg.aircraft) {
      incoming.add(state.hex);
      this.upsert(state, now);
    }
    // full state is authoritative: everything else enters the removal grace
    for (const [hex, t] of this.byHex) {
      if (!incoming.has(hex) && t.missingSinceMs === null) t.missingSinceMs = now;
    }
    this.fetchedAt = msg.fetchedAt;
  }

  applyDelta(msg: WsDeltaMsg): void {
    const now = Date.now();
    for (const state of msg.upsert) this.upsert(state, now);
    for (const hex of msg.remove) {
      const t = this.byHex.get(hex);
      if (t && t.missingSinceMs === null) t.missingSinceMs = now;
    }
    this.fetchedAt = msg.fetchedAt;
  }

  private upsert(state: AircraftState, now: number): void {
    const existing = this.byHex.get(state.hex);
    if (existing) {
      existing.state = state;
      existing.receivedAtMs = now;
      existing.missingSinceMs = null; // reappeared inside the grace window
    } else {
      this.byHex.set(state.hex, {
        state,
        receivedAtMs: now,
        missingSinceMs: null,
        renderLat: state.lat,
        renderLon: state.lon,
        renderAltM: state.altBaroM ?? 0,
      });
    }
  }

  stats(): FeedStats {
    let rendered = 0;
    for (const t of this.byHex.values()) if (!t.state.onGround) rendered++;
    return {
      total: this.byHex.size,
      rendered,
      fetchedAt: this.fetchedAt,
      lastFrameMs: this.lastFrameMs,
    };
  }

  /**
   * Advance one animation frame. Calls `write` once per renderable aircraft
   * with its smoothed position; returns the count written. `dtS` is the time
   * since the previous frame.
   */
  frame(
    dtS: number,
    write: (i: number, hex: string, lat: number, lon: number, altM: number, trackDeg: number) => void,
  ): number {
    const nowMs = Date.now();
    const nowS = nowMs / 1000;
    const blend = 1 - Math.exp(-BLEND_RATE * Math.max(dtS, 0));
    let i = 0;

    for (const [hex, t] of this.byHex) {
      const age = nowMs - t.receivedAtMs;
      if (age > MAX_AGE_MS || (t.missingSinceMs !== null && nowMs - t.missingSinceMs > REMOVE_GRACE_MS)) {
        this.byHex.delete(hex);
        continue;
      }
      const s = t.state;
      if (s.onGround) continue; // ground traffic is clutter at country/region zoom

      // dead-reckoned target from the last reported fix
      let targetLat = s.lat;
      let targetLon = s.lon;
      const track = s.trackDeg ?? 0;
      if (s.groundSpeedMs !== undefined && s.trackDeg !== undefined && s.groundSpeedMs > 1) {
        const dt = Math.min(Math.max(nowS - s.seenAt, 0), MAX_EXTRAPOLATION_S);
        const dist = s.groundSpeedMs * dt;
        targetLat += (dist * Math.cos(track * DEG)) / M_PER_DEG_LAT;
        const latRad = Math.min(Math.abs(targetLat), 89) * DEG;
        targetLon += (dist * Math.sin(track * DEG)) / (M_PER_DEG_LAT * Math.cos(latRad));
      }
      const targetAltM = Math.max(s.altBaroM ?? 0, 0);

      // converge render position toward target (dateline-safe on longitude)
      t.renderLat += (targetLat - t.renderLat) * blend;
      t.renderLon += lonDelta(t.renderLon, targetLon) * blend;
      t.renderLon = ((t.renderLon + 540) % 360) - 180;
      t.renderAltM += (targetAltM - t.renderAltM) * blend;

      write(i++, hex, t.renderLat, t.renderLon, t.renderAltM, track);
    }
    this.lastFrameMs = nowMs;
    return i;
  }
}
