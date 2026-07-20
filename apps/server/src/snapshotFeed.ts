/**
 * Tails the worker's Redis hot state and turns it into WebSocket frames.
 *
 * Detection is a 3s poll of one hash field (`hot:snapshot:meta.updatedAtMs`)
 * rather than pub/sub — see DECISIONS.md: it needs no worker changes, has no
 * subscription state to resync after a Redis hiccup, and 0–3s of extra
 * latency is invisible against a 90s collection cadence.
 */
import type { Redis } from 'ioredis';
import {
  REDIS_KEYS,
  cellIdFor,
  type AircraftState,
  type GlobalSnapshot,
  type WsDeltaMsg,
  type WsMilMsg,
  type WsSnapshotMsg,
} from '@orrery/shared';
import { computeDelta } from './delta.js';
import { log, logError } from './log.js';

const POLL_MS = 3_000;

type DeltaListener = (msg: WsDeltaMsg | WsMilMsg) => void;

export class SnapshotFeed {
  private byHex = new Map<string, AircraftState>();
  private fetchedAt = 0;
  private lastUpdatedAtMs = '';
  private milFetchedAt = 0;
  private milAircraft: AircraftState[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<DeltaListener>();

  constructor(private redis: Redis) {}

  async start(): Promise<void> {
    await this.check(); // initial load before the first client can connect
    this.timer = setInterval(() => {
      void this.check().catch((err) => logError('feed', 'poll failed', err));
    }, POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onDelta(fn: DeltaListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Full state for a newly connected client. */
  snapshotMsg(): WsSnapshotMsg {
    return { type: 'snapshot', fetchedAt: this.fetchedAt, aircraft: [...this.byHex.values()] };
  }

  /** Current military set for a newly connected client. */
  milMsg(): WsMilMsg {
    return { type: 'mil', fetchedAt: this.milFetchedAt, aircraft: this.milAircraft };
  }

  snapshotFetchedAt(): number {
    return this.fetchedAt;
  }

  /** Live aircraft count (for the pager summary — avoids serializing the set). */
  liveCount(): number {
    return this.byHex.size;
  }

  /** Hot-state lookup for pager signal context. */
  aircraftByHex(hex: string): AircraftState | undefined {
    return this.byHex.get(hex);
  }

  /** All live aircraft (overhead scan — one pass per summary request). */
  allAircraft(): IterableIterator<AircraftState> {
    return this.byHex.values();
  }

  /** Current military list (overhead mil flagging). */
  milList(): AircraftState[] {
    return this.milAircraft;
  }

  /** Airborne aircraft currently in a grid cell (live observed count for the baseline API). */
  countInCell(cellId: string): number {
    let n = 0;
    for (const a of this.byHex.values()) {
      if (!a.onGround && cellIdFor(a.lat, a.lon) === cellId) n++;
    }
    return n;
  }

  private async check(): Promise<void> {
    await this.checkMil();
    const updatedAtMs = await this.redis.hget(REDIS_KEYS.hotSnapshotMeta, 'updatedAtMs');
    if (!updatedAtMs || updatedAtMs === this.lastUpdatedAtMs) return;

    const raw = await this.redis.get(REDIS_KEYS.hotSnapshot);
    if (!raw) return;
    const snapshot = JSON.parse(raw) as GlobalSnapshot;
    this.lastUpdatedAtMs = updatedAtMs;

    const isFirst = this.fetchedAt === 0;
    const { upsert, remove } = computeDelta(this.byHex, snapshot.aircraft);
    this.byHex = new Map(snapshot.aircraft.map((a) => [a.hex, a]));
    this.fetchedAt = snapshot.fetchedAt;

    if (isFirst) {
      log('feed', 'initial snapshot loaded', { aircraft: this.byHex.size });
      return; // connected clients (if any) already got it via snapshotMsg
    }
    const msg: WsDeltaMsg = { type: 'delta', fetchedAt: snapshot.fetchedAt, upsert, remove };
    for (const fn of this.listeners) fn(msg);
    log('feed', 'delta broadcast', {
      aircraft: this.byHex.size,
      upsert: upsert.length,
      remove: remove.length,
    });
  }

  private async checkMil(): Promise<void> {
    const raw = await this.redis.get(REDIS_KEYS.hotMil);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { fetchedAt: number; aircraft: AircraftState[] };
    if (parsed.fetchedAt === this.milFetchedAt) return;
    this.milFetchedAt = parsed.fetchedAt;
    this.milAircraft = parsed.aircraft;
    const msg: WsMilMsg = { type: 'mil', fetchedAt: parsed.fetchedAt, aircraft: parsed.aircraft };
    for (const fn of this.listeners) fn(msg);
  }
}
