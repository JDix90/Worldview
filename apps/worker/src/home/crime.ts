/**
 * Home crime vertical (FOUNDATION §12): the Stage 1 collector and Stage 3
 * detectors for crime near home. No AI here; the writer only sees home_event.
 *
 * Collector: Denver Open Data offenses in a box around home, upserted by
 * OFFENSE_ID. The first run backfills ~13 months so the cluster baseline is
 * mature at once (the city's archive goes back years); later runs re-read the
 * last 10 days, because Denver adds and corrects reports late. The query box
 * is centred on the anchor rounded to 0.01° and padded to cover the rounding,
 * so a precise HOME_LAT/LON never leaves the machine (anchor.ts).
 *
 * Detectors:
 *  - nearby: each gunfire or serious violent offense within the walking radius,
 *    reported in the last NEWS_LOOKBACK_DAYS, becomes one event (DECISIONS #144);
 *  - cluster: each category's 7-day count within ½ mi against its prior-year
 *    normal becomes an event when it first crosses, latched in Redis until the
 *    count is back near normal (#143 b).
 */
import type { Redis } from 'ioredis';
import { ulid } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { log } from '../log.js';
import { coarseBox, distMi, resolveHomeAnchor, type HomeAnchor } from './anchor.js';
import {
  CLUSTER_RADIUS_MI,
  NEWS_LOOKBACK_DAYS,
  WALK_RADIUS_MI,
  addDays,
  clusterKeys,
  daysBetween,
  localDay,
  nearbyRule,
  stepCluster,
  trailing7,
} from './crimeRules.js';

export { CLUSTER_RADIUS_MI, WALK_RADIUS_MI };

export const DENVER_CRIME_URL =
  'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/ODC_CRIME_OFFENSES_P/FeatureServer/324';
const BACKFILL_DAYS = 400;
const REREAD_DAYS = 10;
const KEEP_DAYS = 420;
const PAGE = 2000;
const ARMED_KEY = (key: string) => `home:cluster:armed:${key}`;
/** Data health for the note (DECISIONS #147): when the last fetch from Denver
 *  succeeded (epoch ms), and the last failure ({at, error}) since then. */
export const CRIME_OK_KEY = 'home:crime:lastOk';
export const CRIME_ERR_KEY = 'home:crime:lastError';

export interface Offense {
  id: string;
  reportedMs: number;
  occurredMs: number | null;
  category: string;
  type: string;
  address: string;
  neighborhood: string;
  lat: number;
  lon: number;
}

/** GET JSON with retries for stalls, network errors, 429/5xx, bad JSON and
 *  ArcGIS's HTTP-200 `{"error": …}` (the same lesson as DECISIONS #141). */
async function getJson<T>(url: string, label: string): Promise<T> {
  let last: unknown = new Error(`${label}: no attempts`);
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, i * 3_000));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const err = new Error(`${label}: HTTP ${res.status}`);
        if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
        throw err;
      }
      const body = (await res.json()) as T | { error?: unknown };
      if (body && typeof body === 'object' && 'error' in body && body.error) throw new Error(`${label}: query error`);
      return body as T;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      last = e;
    }
  }
  throw last;
}

/** Offenses reported on or after `since` (YYYY-MM-DD) in the coarse box. */
export async function fetchOffenses(home: Pick<HomeAnchor, 'lat' | 'lon'>, since: string): Promise<Offense[]> {
  const out: Offense[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const p = new URLSearchParams({
      where: `REPORTED_DATE >= DATE '${since}' AND IS_CRIME = 1`,
      outFields: 'OFFENSE_ID,OFFENSE_TYPE_ID,OFFENSE_CATEGORY_ID,FIRST_OCCURRENCE_DATE,REPORTED_DATE,INCIDENT_ADDRESS,NEIGHBORHOOD_ID',
      geometry: coarseBox(home, WALK_RADIUS_MI),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outSR: '4326',
      returnGeometry: 'true',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'json',
    });
    const body = await getJson<{
      features?: Array<{ attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } }>;
      exceededTransferLimit?: boolean;
    }>(`${DENVER_CRIME_URL}/query?${p}`, 'Denver crime');
    const feats = body.features ?? [];
    for (const f of feats) {
      const a = f.attributes;
      const x = f.geometry?.x;
      const y = f.geometry?.y;
      if (typeof a.OFFENSE_ID !== 'string' || typeof a.REPORTED_DATE !== 'number') continue;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      out.push({
        id: a.OFFENSE_ID,
        reportedMs: a.REPORTED_DATE,
        occurredMs: typeof a.FIRST_OCCURRENCE_DATE === 'number' ? a.FIRST_OCCURRENCE_DATE : null,
        category: String(a.OFFENSE_CATEGORY_ID ?? 'unknown'),
        type: String(a.OFFENSE_TYPE_ID ?? ''),
        address: String(a.INCIDENT_ADDRESS ?? ''),
        neighborhood: String(a.NEIGHBORHOOD_ID ?? ''),
        lat: y,
        lon: x,
      });
    }
    if (feats.length < PAGE && !body.exceededTransferLimit) break;
  }
  return out;
}

async function upsertOffenses(db: Queryable, rows: Offense[]): Promise<void> {
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    await db.query(
      `INSERT INTO home_crime (id, reported_at, occurred_at, category, offense_type, address, neighborhood, lat, lon)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[],
                            $6::text[], $7::text[], $8::float8[], $9::float8[])
       ON CONFLICT (id) DO UPDATE SET
         reported_at = EXCLUDED.reported_at, occurred_at = EXCLUDED.occurred_at,
         category = EXCLUDED.category, offense_type = EXCLUDED.offense_type,
         address = EXCLUDED.address, neighborhood = EXCLUDED.neighborhood,
         lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
      [
        chunk.map((r) => r.id),
        chunk.map((r) => new Date(r.reportedMs).toISOString()),
        chunk.map((r) => (r.occurredMs === null ? null : new Date(r.occurredMs).toISOString())),
        chunk.map((r) => r.category),
        chunk.map((r) => r.type),
        chunk.map((r) => r.address),
        chunk.map((r) => r.neighborhood),
        chunk.map((r) => r.lat),
        chunk.map((r) => r.lon),
      ],
    );
  }
}

async function insertEvent(db: Queryable, rule: string, dedupeKey: string, payload: unknown): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO home_event (id, ts, rule, dedupe_key, payload) VALUES ($1, now(), $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [ulid(), rule, dedupeKey, JSON.stringify(payload)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Nearby detector: one event per qualifying offense, ever. The window counts
 *  back from `from`: now for routine runs, the newest reported offense for the
 *  backfill run (Denver lags; on a weekend "the last 2 days" of wall-clock time
 *  can hold no published reports at all). */
async function detectNearby(db: Queryable, home: HomeAnchor, lookbackDays: number, from: 'now' | 'newest'): Promise<number> {
  const { rows } = await db.query(
    `SELECT c.id, c.reported_at, c.occurred_at, c.category, c.offense_type, c.address, c.neighborhood, c.lat, c.lon
     FROM home_crime c
     WHERE c.reported_at >= (CASE WHEN $2 = 'newest' THEN (SELECT max(reported_at) FROM home_crime) ELSE now() END)
                            - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM home_event e WHERE e.dedupe_key = 'crime:' || c.id)`,
    [lookbackDays, from],
  );
  let n = 0;
  for (const r of rows) {
    const d = distMi(home.lat, home.lon, r.lat, r.lon);
    const rule = nearbyRule({ category: r.category, type: r.offense_type }, d);
    if (!rule) continue;
    const fresh = await insertEvent(db, rule, `crime:${r.id}`, {
      offenseId: r.id,
      category: r.category,
      type: r.offense_type,
      address: r.address,
      neighborhood: r.neighborhood,
      distMi: Math.round(d * 100) / 100,
      dir: compassFrom(home, r.lat, r.lon),
      reportedAt: r.reported_at,
      occurredAt: r.occurred_at,
    });
    if (fresh) n++;
  }
  return n;
}

/** 8-point compass direction from home (a direction alone reveals nothing). */
function compassFrom(home: HomeAnchor, lat: number, lon: number): string {
  const dy = lat - home.lat;
  const dx = (lon - home.lon) * Math.cos((home.lat * Math.PI) / 180);
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]!;
}

export interface CrimeSeries {
  /** Local days, oldest first, ending at the newest reported day. */
  days: string[];
  newest: string;
  /** Daily counts per cluster key within CLUSTER_RADIUS_MI. */
  ring: Map<string, number[]>;
  /** Daily counts of note-worthy offenses (nearbyRule) within the walking
   *  radius, per rule: the roundup's "normal week" for gunfire and violence. */
  walk: Map<string, number[]>;
}

/** A year of daily series around home, ending at the newest reported day in
 *  the table (the city's lag decides what "this week" can mean). */
export async function crimeSeries(db: Queryable, home: HomeAnchor): Promise<CrimeSeries | null> {
  const { rows } = await db.query(
    `SELECT reported_at, category, offense_type, lat, lon FROM home_crime
     WHERE reported_at >= now() - make_interval(days => $1)`,
    [BACKFILL_DAYS],
  );
  if (rows.length === 0) return null;
  let newest = '';
  const tagged: Array<{ day: string; category: string; type: string; d: number }> = [];
  for (const r of rows) {
    const day = localDay(new Date(r.reported_at).getTime());
    if (day > newest) newest = day;
    tagged.push({ day, category: r.category, type: r.offense_type, d: distMi(home.lat, home.lon, r.lat, r.lon) });
  }
  const days = daysBetween(addDays(newest, -(BACKFILL_DAYS - 1)), newest);
  const idx = new Map(days.map((d, i) => [d, i]));
  const bump = (m: Map<string, number[]>, k: string, j: number) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Array<number>(days.length).fill(0)));
    s[j]!++;
  };
  const ring = new Map<string, number[]>();
  const walk = new Map<string, number[]>();
  for (const o of tagged) {
    const j = idx.get(o.day);
    if (j === undefined) continue;
    if (o.d <= CLUSTER_RADIUS_MI) for (const k of clusterKeys(o.category)) bump(ring, k, j);
    const rule = nearbyRule({ category: o.category, type: o.type }, o.d);
    if (rule) bump(walk, rule, j);
  }
  return { days, newest, ring, walk };
}

/** Cluster detector, evaluated at the newest reported day. */
async function detectClusters(db: Queryable, redis: Redis, home: HomeAnchor): Promise<number> {
  const s = await crimeSeries(db, home);
  if (!s) return 0;
  const { days, newest } = s;
  let n = 0;
  const last = days.length - 1;
  for (const [key, daily] of s.ring) {
    const armed = (await redis.get(ARMED_KEY(key))) !== '0';
    const step = stepCluster(trailing7(daily), last, armed);
    if (!step) continue;
    if (step.fire) {
      const fresh = await insertEvent(db, 'crime.cluster', `cluster:${key}:${newest}`, {
        key,
        count: step.count,
        normal: step.levels.median,
        alertAt: Math.ceil(step.levels.alertAt),
        radiusMi: CLUSTER_RADIUS_MI,
        windowEnd: newest,
      });
      if (fresh) n++;
    }
    if (step.armed !== armed) await redis.set(ARMED_KEY(key), step.armed ? '1' : '0');
  }
  return n;
}

export async function jobHomeCrime(redis: Redis, db: Queryable): Promise<void> {
  const home = await resolveHomeAnchor(redis);
  const { rows } = await db.query(`SELECT max(reported_at) AS hi, count(*)::int AS n FROM home_crime`);
  const today = localDay(Date.now());
  const backfill = rows[0].n === 0 || !rows[0].hi;
  const since = backfill
    ? addDays(today, -BACKFILL_DAYS)
    : addDays(localDay(new Date(rows[0].hi).getTime()), -REREAD_DAYS);
  let offenses: Offense[];
  try {
    offenses = await fetchOffenses(home, since);
  } catch (err) {
    // Recorded so the morning note can say the data is missing instead of
    // reading as a quiet day (DECISIONS #147); BullMQ still logs the failure.
    await redis.set(CRIME_ERR_KEY, JSON.stringify({ at: Date.now(), error: String(err).slice(0, 200) }));
    throw err;
  }
  await upsertOffenses(db, offenses);
  await redis.set(CRIME_OK_KEY, String(Date.now()));
  await redis.del(CRIME_ERR_KEY);
  await db.query(`DELETE FROM home_crime WHERE reported_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
  // The first run starts the news at the newest couple of days of data, so the
  // first note isn't a week's backlog (and isn't empty on a weekend).
  const nearby = backfill
    ? await detectNearby(db, home, 2, 'newest')
    : await detectNearby(db, home, NEWS_LOOKBACK_DAYS, 'now');
  const clusters = await detectClusters(db, redis, home);
  log('home', 'crime run', {
    since,
    fetched: offenses.length,
    nearbyEvents: nearby,
    clusterEvents: clusters,
    anchor: home.precise ? 'precise' : 'rounded',
  });
}
