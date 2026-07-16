/**
 * WebSocket wire protocol — server (apps/server) and client (apps/web) both
 * import these, so the two ends cannot drift. One socket, three frame types:
 *
 *  snapshot — full state, sent once on connect and after any server-side reset
 *  delta    — per-poll changes: upserted aircraft + removed hexes
 *  meta     — 30s heartbeat: snapshot age (client staleness display) and
 *             liveness (client watchdog reconnects if nothing arrives in 75s)
 */
import type { AircraftState } from './aircraft.js';

export interface WsSnapshotMsg {
  type: 'snapshot';
  /** Source epoch seconds of the underlying poll. */
  fetchedAt: number;
  aircraft: AircraftState[];
}

export interface WsDeltaMsg {
  type: 'delta';
  fetchedAt: number;
  /** New aircraft and aircraft whose state changed since the previous poll. */
  upsert: AircraftState[];
  /** Hexes absent from the latest poll. Client applies a grace period before dropping. */
  remove: string[];
}

export interface WsMetaMsg {
  type: 'meta';
  snapshotFetchedAt: number;
  snapshotAgeS: number;
  serverTimeMs: number;
}

export type WsServerMsg = WsSnapshotMsg | WsDeltaMsg | WsMetaMsg;

/** Close code the server uses when the auth token is missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 1008;
