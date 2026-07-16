/**
 * Stage 3 job glue: gathers inputs from Redis/Postgres, runs the pure
 * detectors (D0 first — its verdict gates and annotates everything), emits
 * Signals. Runs every 60s. D1/D3 self-gate on baseline maturity, so they are
 * wired but silent until baselines leave warmup.
 */
import type { Redis } from 'ioredis';
import {
  GPS_WATCH_REGIONS,
  REDIS_KEYS,
  cellCenter,
  cellIdFor,
  daytypeOf,
  type GlobalSnapshot,
  type Signal,
} from '@orrery/shared';
import type { Queryable } from '../db.js';
import { detectDataHealth, type D0Result } from './d0DataHealth.js';
import {
  detectSquawks,
  type D2State,
  type EmergencyCode,
  type SquawkSighting,
} from './d2Squawks.js';
import { detectCollapse, type CellBaseline, type D1State } from './d1Collapse.js';
import { detectGpsInterference, type D3State, type RegionSample, type RegionHistoryStats } from './d3Gps.js';
import { SignalEmitter } from './emit.js';

const EMERGENCY_CODES: EmergencyCode[] = ['7500', '7600', '7700'];

export async function jobDetect(redis: Redis, db: Queryable): Promise<void> {
  const nowS = Date.now() / 1000;
  const emitter = new SignalEmitter(redis, db);

  // ── inputs ─────────────────────────────────────────────────────────
  const raw = await redis.get(REDIS_KEYS.hotSnapshot);
  const snapshot = raw ? (JSON.parse(raw) as GlobalSnapshot) : null;
  const airborne = snapshot ? snapshot.aircraft.filter((a) => !a.onGround) : [];

  const { rows: recent } = await db.query(
    `SELECT extract(epoch FROM bucket_ts)::float8 AS ts, total_aircraft AS total
     FROM rollup_run WHERE bucket_ts >= now() - interval '1 hour' ORDER BY bucket_ts`,
  );

  // ── D0 — data health ───────────────────────────────────────────────
  const d0 = detectDataHealth({
    nowS,
    snapshotFetchedAt: snapshot?.fetchedAt ?? 0,
    totalAirborne: airborne.length,
    recentTotals: recent.map((r) => ({ ts: Number(r.ts), total: Number(r.total) })),
  });
  await redis.set(REDIS_KEYS.healthCoverageOk, d0.coverageOk ? '1' : '0');

  const dataHealth: Signal['data_health'] = {
    coverage_ok: d0.coverageOk,
    global_count_delta_pct: Math.round(d0.globalDeltaPct * 10) / 10,
  };
  const window = {
    window_start: new Date((nowS - 60) * 1000).toISOString(),
    window_end: new Date(nowS * 1000).toISOString(),
  };

  for (const c of d0.conditions) {
    await emitter.emit({
      source: 'flights',
      detector: 'data_health',
      severity: 'S3',
      what: c.what,
      where: { region: 'global', lat: 0, lon: 0 },
      magnitude: { metric: c.kind, observed: c.observed, baseline: c.reference, deviation: 0 },
      confidence: 0.9,
      baseline_maturity: 'n/a',
      data_health: dataHealth,
      evidence: { ...window, aircraft_count: airborne.length },
      dedupe_key: `d0:${c.kind}`,
    });
  }

  // ── D2 — emergency squawks ─────────────────────────────────────────
  // merge adsb.fi targeted polls (fresher, richer) with the OpenSky snapshot
  // (catches aircraft outside adsb.fi coverage)
  const bySquawk = {} as Record<EmergencyCode, SquawkSighting[]>;
  for (const code of EMERGENCY_CODES) {
    const byHex = new Map<string, SquawkSighting>();
    for (const a of airborne) {
      if (a.squawk === code) {
        byHex.set(a.hex, {
          hex: a.hex, lat: a.lat, lon: a.lon, callsign: a.callsign,
          seenAt: a.seenAt, onGround: a.onGround,
        });
      }
    }
    const targeted = await redis.get(REDIS_KEYS.hotSquawk(code));
    if (targeted) {
      const parsed = JSON.parse(targeted) as { fetchedAt: number; aircraft: (SquawkSighting & { onGround?: boolean })[] };
      if (nowS - parsed.fetchedAt < 180) {
        for (const a of parsed.aircraft) byHex.set(a.hex, a); // adsb.fi wins on conflict
      }
    }
    bySquawk[code] = [...byHex.values()];
  }

  const stateRaw = await redis.get(REDIS_KEYS.detectStateD2);
  const state: D2State = stateRaw ? (JSON.parse(stateRaw) as D2State) : { entries: {} };
  const { events, state: nextState } = detectSquawks(nowS, bySquawk, state);
  await redis.set(REDIS_KEYS.detectStateD2, JSON.stringify(nextState));

  for (const e of events) {
    await emitter.emit({
      source: 'flights',
      detector: 'emergency_squawk',
      severity: e.severity,
      what: e.what,
      where: { region: cellIdFor(e.lat, e.lon), lat: e.lat, lon: e.lon },
      magnitude: { metric: e.kind, observed: e.hexes.length, baseline: 0, deviation: 0 },
      confidence: e.confidence,
      baseline_maturity: 'n/a',
      data_health: dataHealth,
      evidence: { ...window, aircraft_count: e.hexes.length, sample_hexes: e.hexes.slice(0, 5) },
      dedupe_key: e.dedupeKey,
    });
  }

  // ── D1 — regional traffic collapse ─────────────────────────────────
  if (snapshot) {
    const now = new Date(nowS * 1000);
    const daytype = daytypeOf(now);
    const { rows: baseRows } = await db.query(
      `SELECT cell, median::float8 AS median, mad::float8 AS mad, days
       FROM baseline WHERE hour = $1 AND daytype = $2`,
      [now.getUTCHours(), daytype],
    );
    const baselines: Record<string, CellBaseline> = {};
    for (const r of baseRows) {
      baselines[r.cell] = { median: r.median, mad: r.mad, days: r.days, daytype };
    }
    const cellCounts: Record<string, number> = {};
    for (const a of airborne) {
      const cell = cellIdFor(a.lat, a.lon);
      cellCounts[cell] = (cellCounts[cell] ?? 0) + 1;
    }

    const d1Raw = await redis.get(REDIS_KEYS.detectStateD1);
    const d1State: D1State = d1Raw ? (JSON.parse(d1Raw) as D1State) : { entries: {} };
    const d1 = detectCollapse(
      { nowS, snapshotFetchedAt: snapshot.fetchedAt, cellCounts, baselines, coverageOk: d0.coverageOk },
      d1State,
    );
    await redis.set(REDIS_KEYS.detectStateD1, JSON.stringify(d1.state));

    for (const e of d1.events) {
      const center = cellCenter(e.cell);
      await emitter.emit({
        source: 'flights',
        detector: 'traffic_collapse',
        severity: e.severity,
        what: e.what,
        where: { region: e.cell, lat: center.lat, lon: center.lon, radius_km: 280 },
        magnitude: { metric: 'aircraft_count', observed: e.observed, baseline: e.median, deviation: e.deviation },
        confidence: e.confidence,
        baseline_maturity: e.maturity,
        data_health: dataHealth,
        evidence: { ...window, aircraft_count: e.observed },
        dedupe_key: e.dedupeKey,
      });
    }
  }

  // ── D3 — GPS interference over the watch regions ───────────────────
  const samples: RegionSample[] = [];
  for (const region of GPS_WATCH_REGIONS) {
    const rawIntegrity = await redis.get(REDIS_KEYS.hotIntegrity(region.id));
    if (!rawIntegrity) continue;
    const parsed = JSON.parse(rawIntegrity) as { fetchedAt: number; aircraft: Array<{ nic?: number }> };
    if (nowS - parsed.fetchedAt > 600) continue; // stale sweep — not evidence
    const withNic = parsed.aircraft.filter((a) => typeof a.nic === 'number');
    samples.push({
      regionId: region.id,
      name: region.name,
      fetchedAt: parsed.fetchedAt,
      aircraft: withNic.length,
      lowNic: withNic.filter((a) => (a.nic as number) <= 4).length,
    });
  }

  if (samples.length > 0) {
    const { rows: histRows } = await db.query(
      `SELECT region,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY low_nic::float8 / NULLIF(aircraft, 0)) AS median_fraction,
              count(DISTINCT (bucket_ts AT TIME ZONE 'UTC')::date)::int AS days
       FROM integrity_rollup
       WHERE bucket_ts >= now() - interval '14 days' AND aircraft >= 10
       GROUP BY region`,
    );
    const history: Record<string, RegionHistoryStats> = {};
    for (const r of histRows) {
      history[r.region] = { medianFraction: Number(r.median_fraction ?? 0), days: r.days };
    }

    const d3Raw = await redis.get(REDIS_KEYS.detectStateD3);
    const d3State: D3State = d3Raw ? (JSON.parse(d3Raw) as D3State) : { entries: {} };
    const d3 = detectGpsInterference({ nowS, samples, history }, d3State);
    await redis.set(REDIS_KEYS.detectStateD3, JSON.stringify(d3.state));

    for (const e of d3.events) {
      const region = GPS_WATCH_REGIONS.find((r) => r.id === e.regionId)!;
      const lat = region.tiles.reduce((s, t) => s + t.lat, 0) / region.tiles.length;
      const lon = region.tiles.reduce((s, t) => s + t.lon, 0) / region.tiles.length;
      await emitter.emit({
        source: 'flights',
        detector: 'gps_interference',
        severity: e.severity,
        what: e.what,
        where: { region: region.name, lat, lon, radius_km: 460 },
        magnitude: {
          metric: 'low_nic_fraction',
          observed: Math.round(e.fraction * 1000) / 1000,
          baseline: Math.round(e.medianFraction * 1000) / 1000,
          deviation: e.medianFraction > 0 ? Math.round((e.fraction / e.medianFraction) * 10) / 10 : 0,
        },
        confidence: e.confidence,
        baseline_maturity: e.maturity,
        data_health: dataHealth,
        evidence: { ...window, aircraft_count: e.aircraft },
        dedupe_key: e.dedupeKey,
      });
    }
  }
}
