/**
 * Internal HTTP API (bearer auth): baseline queries and rollup status.
 * Read-only — the worker owns all writes. Chunk 4's "small internal API".
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  GPS_WATCH_REGIONS,
  REDIS_KEYS,
  daytypeOf,
  maturityOf,
  type BaselineEntry,
  type Daytype,
} from '@orrery/shared';
import { env } from './env.js';
import type { SnapshotFeed } from './snapshotFeed.js';
import { nearestCity, distMiles, compass16 } from './data/cities.js';
import { routeLabel } from './routes.js';

const CELL_RE = /^[NS]\d{2}[EW]\d{3}$/;
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
const OVERHEAD_RADIUS_MI = 150;

const BRIEF_HEADER_RE = /^(morning brief|night watch|orrery\b|.*24h window)/i;
const BRIEF_LABEL_RE = /^(what changed|inferred|unknown|data health|confidence)\s*:/i;

/** Truncate at a sentence boundary before `max`; never mid-word. */
function sentenceTrim(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  const lastEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (lastEnd > max * 0.5) return t.slice(0, lastEnd + 1);
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > 0 ? t.slice(0, lastSpace) : window).trimEnd() + '…';
}

/**
 * Carve a glanceable snippet from the full briefing: the bottom-line verdict,
 * the "what changed" line, and the duty-officer sign-off — dropping the
 * boilerplate header (the date is shown separately) and cutting on sentence
 * boundaries. Signature-neutral to quiet nights (changed/signoff → null).
 */
function extractBriefing(b: { date_local: string; body_md: string; quiet: boolean }) {
  const paras = b.body_md
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean);
  if (paras[0] && BRIEF_HEADER_RE.test(paras[0])) paras.shift();

  const lead = paras[0] ? sentenceTrim(paras[0], 240) : '';
  const changedRaw = paras.find((p) => /^what changed\s*:/i.test(p));
  const changed = changedRaw ? sentenceTrim(changedRaw.replace(/^what changed\s*:\s*/i, ''), 300) : null;

  const last = paras[paras.length - 1] ?? '';
  const signoff =
    last && last.length <= 130 && !BRIEF_LABEL_RE.test(last) && last !== paras[0] ? last : null;

  return { date: b.date_local, quiet: b.quiet, lead, changed, signoff };
}

interface BaselineRow {
  cell: string;
  hour: number;
  daytype: Daytype;
  median: number;
  mad: number;
  samples: number;
  days: number;
}

function toEntry(r: BaselineRow): BaselineEntry {
  return { ...r, maturity: maturityOf(r.days, r.daytype) };
}

export function registerApi(
  app: FastifyInstance,
  pool: pg.Pool,
  feed: SnapshotFeed,
  redis: Redis,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${env.authToken}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });

    scope.get<{ Querystring: { limit?: string; severity?: string } }>(
      '/api/signals',
      async (req) => {
        const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
        const severity = req.query.severity;
        const where = severity ? 'WHERE s.severity = $2' : '';
        const params: unknown[] = severity ? [limit, severity] : [limit];
        const { rows } = await pool.query(
          `SELECT s.payload,
                  CASE WHEN a.signal_id IS NULL THEN NULL ELSE
                    jsonb_build_object(
                      'disposition', a.disposition, 'severity_final', a.severity_final,
                      'narrative', a.narrative, 'sources_consulted', a.sources,
                      'confidence', a.confidence)
                  END AS assessment
           FROM signal s LEFT JOIN assessment a ON a.signal_id = s.id
           ${where} ORDER BY s.ts DESC LIMIT $1`,
          params,
        );
        return { signals: rows.map((r) => ({ ...r.payload, assessment: r.assessment })) };
      },
    );

    scope.get<{ Querystring: { limit?: string } }>('/api/briefings', async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 7) || 7, 60);
      const { rows } = await pool.query(
        `SELECT id, date_local, ts, body_md, quiet FROM briefing ORDER BY date_local DESC LIMIT $1`,
        [limit],
      );
      return { briefings: rows };
    });

    scope.get('/api/shadow-log', async () => {
      const { rows } = await pool.query(
        `SELECT id, ts, signal, assessment, would_send, pushed
         FROM shadow_push ORDER BY ts DESC LIMIT 100`,
      );
      return { entries: rows };
    });

    // Live per-region GPS integrity (the jamming furniture layer reads this).
    // Same NIC≤4 logic as detector D3, over the same hot sweep keys.
    scope.get('/api/integrity/now', async () => {
      const nowS = Date.now() / 1000;
      const regions = await Promise.all(
        GPS_WATCH_REGIONS.map(async (region) => {
          const raw = await redis.get(REDIS_KEYS.hotIntegrity(region.id));
          if (!raw) {
            return { regionId: region.id, name: region.name, fraction: null, aircraft: 0, fetchedAt: 0 };
          }
          const parsed = JSON.parse(raw) as { fetchedAt: number; aircraft: Array<{ nic?: number }> };
          const withNic = parsed.aircraft.filter((a) => typeof a.nic === 'number');
          const stale = nowS - parsed.fetchedAt > 600;
          return {
            regionId: region.id,
            name: region.name,
            fraction: stale || withNic.length === 0
              ? null
              : withNic.filter((a) => (a.nic as number) <= 4).length / withNic.length,
            aircraft: withNic.length,
            fetchedAt: parsed.fetchedAt,
          };
        }),
      );
      return { regions };
    });

    // ── Pager summary: one compact Stage-4 digest for the Zero 2 W handheld ──
    // The handheld stays dumb — it renders this, never touches raw data. Keep
    // the payload small (~2KB): the pager polls it every 90s over 2.4GHz WiFi.
    // Home anchor: Redis override (HOME chip) else env default (Denver metro).
    async function resolveHome(): Promise<{ lat: number; lon: number }> {
      try {
        const raw = await redis.get('settings:home');
        if (raw) {
          const h = JSON.parse(raw) as { lat?: number; lon?: number };
          if (typeof h.lat === 'number' && typeof h.lon === 'number') return { lat: h.lat, lon: h.lon };
        }
      } catch {
        /* fall through to env */
      }
      return { lat: env.ownerLat, lon: env.ownerLon };
    }

    scope.get('/api/pager/summary', async () => {
      const nowMs = Date.now();
      const home = await resolveHome();
      const [signals, briefing, shadow24h] = await Promise.all([
        pool.query(
          `SELECT s.severity, s.ts, s.payload->>'what' AS what,
                  s.payload->'where'->>'region' AS region,
                  (s.payload->'where'->>'lat')::float8 AS lat,
                  (s.payload->'where'->>'lon')::float8 AS lon,
                  s.payload->'evidence'->'sample_hexes'->>0 AS hex,
                  a.disposition, a.narrative
           FROM signal s LEFT JOIN assessment a ON a.signal_id = s.id
           WHERE s.severity IN ('S1','S2') ORDER BY s.ts DESC LIMIT 5`,
        ),
        pool.query(`SELECT date_local, body_md, quiet FROM briefing ORDER BY date_local DESC LIMIT 1`),
        pool.query(`SELECT count(*)::int AS n FROM shadow_push WHERE ts >= now() - interval '24 hours'`),
      ]);

      const integrity = await Promise.all(
        GPS_WATCH_REGIONS.map(async (region) => {
          const raw = await redis.get(REDIS_KEYS.hotIntegrity(region.id));
          let fraction: number | null = null;
          if (raw) {
            const parsed = JSON.parse(raw) as { fetchedAt: number; aircraft: Array<{ nic?: number }> };
            const withNic = parsed.aircraft.filter((a) => typeof a.nic === 'number');
            const stale = nowMs / 1000 - parsed.fetchedAt > 600;
            if (!stale && withNic.length > 0) {
              fraction = withNic.filter((a) => (a.nic as number) <= 4).length / withNic.length;
            }
          }
          const verdict =
            fraction === null ? 'no-data' : fraction < 0.15 ? 'nominal' : fraction < 0.45 ? 'elevated' : 'severe';
          return { name: region.name, verdict, pct: fraction === null ? null : Math.round(fraction * 100) };
        }),
      );

      const b = briefing.rows[0] as { date_local: string; body_md: string; quiet: boolean } | undefined;
      const briefingSnippet = b ? extractBriefing(b) : null;

      // Signal context: place words, distance from home, live-aircraft state,
      // route (cached adsbdb; squawk signals only — ≤5 lookups per request,
      // nearly always cache hits).
      const enrichedSignals = await Promise.all(
        signals.rows.map(async (r) => {
          const lat = r.lat as number | null;
          const lon = r.lon as number | null;
          const hex = r.hex as string | null;
          const ac = hex ? feed.aircraftByHex(hex) : undefined;
          const isSquawk = typeof r.what === 'string' && (r.what as string).includes('squawking');
          const route = isSquawk && ac?.callsign ? await routeLabel(redis, ac.callsign) : null;
          return {
            severity: r.severity as string,
            what: r.what as string,
            region: r.region as string | null,
            disposition: r.disposition as string | null,
            narrative: r.narrative ? (r.narrative as string).slice(0, 140) : null,
            ageS: Math.max(0, Math.round((nowMs - new Date(r.ts as string).getTime()) / 1000)),
            place: lat != null && lon != null ? nearestCity(lat, lon).label : null,
            distMi: lat != null && lon != null ? Math.round(distMiles(home.lat, home.lon, lat, lon)) : null,
            bearing: lat != null && lon != null ? compass16(home.lat, home.lon, lat, lon) : null,
            aircraft: ac
              ? {
                  callsign: ac.callsign ?? null,
                  altFt: ac.altBaroM != null ? Math.round(ac.altBaroM * 3.28084) : null,
                  live: true,
                  stillSquawking: !!ac.squawk && EMERGENCY_SQUAWKS.has(ac.squawk),
                }
              : hex
                ? { callsign: null, altFt: null, live: false, stillSquawking: false }
                : null,
            route,
          };
        }),
      );

      // Overhead: one pass over hot state; military flagged via the mil list.
      const milHexes = new Set(feed.milList().map((a) => a.hex));
      const milByHex = new Map(feed.milList().map((a) => [a.hex, a]));
      let overheadCount = 0;
      const tops: Array<{
        callsign: string | null; altFt: number | null; distMi: number;
        bearing: string; mil: boolean; typeDesc: string | null;
      }> = [];
      for (const a of feed.allAircraft()) {
        if (a.onGround) continue;
        const d = distMiles(home.lat, home.lon, a.lat, a.lon);
        if (d > OVERHEAD_RADIUS_MI) continue;
        overheadCount++;
        tops.push({
          callsign: a.callsign ?? null,
          altFt: a.altBaroM != null ? Math.round(a.altBaroM * 3.28084) : null,
          distMi: Math.round(d),
          bearing: compass16(home.lat, home.lon, a.lat, a.lon),
          mil: milHexes.has(a.hex),
          typeDesc: milByHex.get(a.hex)?.typeDesc ?? null,
        });
      }
      tops.sort((x, y) => x.distMi - y.distMi);
      const milCount = feed
        .milList()
        .filter((a) => !a.onGround && distMiles(home.lat, home.lon, a.lat, a.lon) <= OVERHEAD_RADIUS_MI).length;

      return {
        generatedAt: new Date(nowMs).toISOString(),
        home,
        feed: {
          live: feed.liveCount() > 0 && nowMs / 1000 - feed.snapshotFetchedAt() < 300,
          aircraft: feed.liveCount(),
          dataAgeS: Math.max(0, Math.round(nowMs / 1000 - feed.snapshotFetchedAt())),
        },
        signals: enrichedSignals,
        briefing: briefingSnippet,
        integrity,
        integrityAllNominal: integrity.every((r) => r.verdict === 'nominal' || r.verdict === 'no-data'),
        overhead: { count: overheadCount, milCount, tops: tops.slice(0, 4) },
        shadowS1Last24h: shadow24h.rows[0].n as number,
      };
    });

    // ── home anchor: settable from the globe's HOME chip ──
    scope.get('/api/settings/home', async () => {
      const home = await resolveHome();
      return { ...home, label: nearestCity(home.lat, home.lon).label };
    });

    scope.post<{ Body: { lat?: number; lon?: number } }>('/api/settings/home', async (req, reply) => {
      const { lat, lon } = req.body ?? {};
      if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return reply.code(400).send({ error: 'lat/lon required (±90/±180)' });
      }
      const home = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
      await redis.set('settings:home', JSON.stringify(home));
      return home;
    });

    // ── appliance display control: browser chip ↔ Redis pref ↔ display ──
    // The Pi's display service polls GET /api/display with its summary poll
    // (~90s) and applies the newest of {this pref, the local ctl file}.
    scope.get('/api/display', async () => {
      const raw = await redis.get('display:ctl');
      return raw ? (JSON.parse(raw) as { mode: string; ts: number }) : { mode: 'auto', ts: 0 };
    });

    scope.post<{ Body: { mode?: string } }>('/api/display', async (req, reply) => {
      const mode = req.body?.mode;
      if (mode !== 'on' && mode !== 'off' && mode !== 'auto') {
        return reply.code(400).send({ error: "mode must be 'on' | 'off' | 'auto'" });
      }
      const pref = { mode, ts: Date.now() };
      await redis.set('display:ctl', JSON.stringify(pref));
      return pref;
    });

    // ── upstream proxies for furniture layers whose sources lack CORS ──
    // (NHC storms; FIRMS fires as fallback). Cached in-memory; stale copies
    // are served when the upstream hiccups — furniture degrades, never errors.
    const proxyCache = new Map<string, { at: number; body: unknown; contentType: string }>();
    const proxied = async (key: string, url: string, ttlMs: number, contentType: string) => {
      const hit = proxyCache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit;
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'ORRERY (personal, non-commercial)' } });
        if (!res.ok) throw new Error(`${key} upstream HTTP ${res.status}`);
        const body = contentType === 'application/json' ? await res.json() : await res.text();
        const entry = { at: Date.now(), body, contentType };
        proxyCache.set(key, entry);
        return entry;
      } catch (err) {
        if (hit) return hit; // stale beats nothing for display furniture
        throw err;
      }
    };

    scope.get('/api/proxy/storms', async (_req, reply) => {
      const entry = await proxied('storms', 'https://www.nhc.noaa.gov/CurrentStorms.json', 15 * 60_000, 'application/json');
      return reply.type(entry.contentType).send(entry.body);
    });

    // ?bbox=west,south,east,north scopes to an area (the HOME dashboard uses
    // this — FIRMS omits CORS headers on error responses, so a browser can't
    // fetch it directly and reliably; the same-origin proxy + stale-serve
    // insulates from FIRMS's aggressive rate limiting). Default = world.
    const BBOX_RE = /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/;
    scope.get<{ Querystring: { bbox?: string } }>('/api/proxy/fires', async (req, reply) => {
      const key = process.env.FIRMS_MAP_KEY ?? '';
      if (!key) return reply.code(503).send({ error: 'FIRMS_MAP_KEY not configured' });
      const bbox = req.query.bbox && BBOX_RE.test(req.query.bbox) ? req.query.bbox : 'world';
      const entry = await proxied(
        `fires:${bbox}`,
        // NOAA-20: Suomi-NPP NRT is deprecated (0 rows, verified 2026-07-16)
        `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/${bbox}/1`,
        30 * 60_000,
        'text/csv',
      );
      return reply.type(entry.contentType).send(entry.body);
    });

    // ── instrument heartbeat: read-only stats for the sparkline + learning ──
    scope.get('/api/stats/traffic24h', async () => {
      const { rows } = await pool.query(
        `SELECT extract(epoch from bucket_ts)::bigint * 1000 AS ts, total_aircraft AS total
         FROM rollup_run WHERE bucket_ts >= now() - interval '24 hours' ORDER BY bucket_ts`,
      );
      return { points: rows.map((r) => ({ ts: Number(r.ts), total: r.total as number })) };
    });

    scope.get('/api/stats/learning', async () => {
      const { rows } = await pool.query(
        `SELECT daytype, days, count(*)::int AS n FROM baseline GROUP BY daytype, days`,
      );
      let mature = 0, partial = 0, warmup = 0, totalBins = 0, maxDays = 0;
      for (const r of rows) {
        const m = maturityOf(r.days as number, r.daytype as Daytype);
        const n = r.n as number;
        totalBins += n;
        maxDays = Math.max(maxDays, r.days as number);
        if (m === 'mature') mature += n;
        else if (m === 'partial') partial += n;
        else warmup += n;
      }
      return { totalBins, mature, partial, warmup, days: maxDays };
    });

    scope.get('/api/analyst/usage', async () => {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(est_cost_usd), 0)::float8 AS mtd_usd,
                count(*)::int AS calls,
                coalesce(sum(web_searches), 0)::int AS searches
         FROM analyst_usage WHERE ts >= date_trunc('month', now())`,
      );
      return { monthToDate: rows[0] };
    });

    scope.get('/api/rollups/status', async () => {
      const latest = await pool.query(
        `SELECT bucket_ts, total_aircraft, cells FROM rollup_run ORDER BY bucket_ts DESC LIMIT 1`,
      );
      const day = await pool.query(
        `SELECT count(*)::int AS buckets FROM rollup_run WHERE bucket_ts >= now() - interval '24 hours'`,
      );
      const bins = await pool.query(`SELECT count(*)::int AS bins FROM baseline`);
      const run = latest.rows[0];
      return {
        latestBucket: run?.bucket_ts ?? null,
        latestTotalAircraft: run?.total_aircraft ?? null,
        latestCells: run?.cells ?? null,
        bucketsLast24h: day.rows[0].buckets,
        baselineBins: bins.rows[0].bins,
      };
    });

    scope.get<{ Params: { cell: string } }>('/api/baseline/:cell', async (req, reply) => {
      const { cell } = req.params;
      if (!CELL_RE.test(cell)) return reply.code(400).send({ error: 'bad cell id' });
      const { rows } = await pool.query<BaselineRow>(
        `SELECT cell, hour, daytype, median, mad, samples, days
         FROM baseline WHERE cell = $1 ORDER BY daytype, hour`,
        [cell],
      );
      return { cell, entries: rows.map(toEntry) };
    });

    scope.get<{ Params: { cell: string } }>('/api/baseline/:cell/now', async (req, reply) => {
      const { cell } = req.params;
      if (!CELL_RE.test(cell)) return reply.code(400).send({ error: 'bad cell id' });
      const now = new Date();
      const hour = now.getUTCHours();
      const daytype = daytypeOf(now);
      const { rows } = await pool.query<BaselineRow>(
        `SELECT cell, hour, daytype, median, mad, samples, days
         FROM baseline WHERE cell = $1 AND hour = $2 AND daytype = $3`,
        [cell, hour, daytype],
      );
      return {
        cell,
        hour,
        daytype,
        observed: feed.countInCell(cell),
        snapshotFetchedAt: feed.snapshotFetchedAt(),
        baseline: rows[0] ? toEntry(rows[0]) : null,
      };
    });
  });
}
