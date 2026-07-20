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

const CELL_RE = /^[NS]\d{2}[EW]\d{3}$/;

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
    scope.get('/api/pager/summary', async () => {
      const nowMs = Date.now();
      const [signals, briefing, shadow24h] = await Promise.all([
        pool.query(
          `SELECT s.severity, s.ts, s.payload->>'what' AS what,
                  s.payload->'where'->>'region' AS region, a.disposition
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
      const briefLines = (b?.body_md ?? '')
        .split('\n')
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .filter(Boolean);

      return {
        generatedAt: new Date(nowMs).toISOString(),
        feed: {
          live: feed.liveCount() > 0 && nowMs / 1000 - feed.snapshotFetchedAt() < 300,
          aircraft: feed.liveCount(),
          dataAgeS: Math.max(0, Math.round(nowMs / 1000 - feed.snapshotFetchedAt())),
        },
        signals: signals.rows.map((r) => ({
          severity: r.severity as string,
          what: r.what as string,
          region: r.region as string | null,
          disposition: r.disposition as string | null,
          ageS: Math.max(0, Math.round((nowMs - new Date(r.ts as string).getTime()) / 1000)),
        })),
        briefing: b
          ? { date: b.date_local, quiet: b.quiet, headline: briefLines[0] ?? '', open: briefLines.slice(1, 4).join(' ').slice(0, 240) }
          : null,
        integrity,
        shadowS1Last24h: shadow24h.rows[0].n as number,
      };
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

    scope.get('/api/proxy/fires', async (_req, reply) => {
      const key = process.env.FIRMS_MAP_KEY ?? '';
      if (!key) return reply.code(503).send({ error: 'FIRMS_MAP_KEY not configured' });
      const entry = await proxied(
        'fires',
        // NOAA-20: Suomi-NPP NRT is deprecated (0 rows, verified 2026-07-16)
        `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/world/1`,
        30 * 60_000,
        'text/csv',
      );
      return reply.type(entry.contentType).send(entry.body);
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
