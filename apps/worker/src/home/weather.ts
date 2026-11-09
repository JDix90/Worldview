/**
 * Home weather vertical (FOUNDATION §12, DECISIONS #148): Stage 1 collector
 * and Stage 3 detectors for weather and air near home. Every call sends the
 * home point rounded to 0.1° (~7 mi); weather needs no more.
 *
 *  - NWS alerts, every run: warnings and advisories in effect for the point
 *    (not dense fog, not watches: weatherRules.keepAlert). One event per NWS
 *    event (office + phenomenon + significance + number), carrying its end
 *    time so a note never reports an alert that has already ended. An
 *    extension updates the end time while the event is still un-noted.
 *  - Forecast and air, once a day in the two hours before the note: today's
 *    high, snow, rain and gusts and tonight's low (Open-Meteo), and today's
 *    forecast air quality → season firsts and extremes, made fresh each
 *    morning so a note never carries yesterday's forecast.
 */
import type { Redis } from 'ioredis';
import { ulid } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { env } from '../env.js';
import { log } from '../log.js';
import { coarsen, resolveHomeAnchor } from './anchor.js';
import { addDays, localDay } from './crimeRules.js';
import {
  aqEpisodeStarts,
  dayFindings,
  keepAlert,
  keepAlertByName,
  parseVtec,
  seasonOf,
  type SeasonState,
} from './weatherRules.js';

const TZ = 'America/Denver';
const UA = { 'user-agent': 'ORRERY (personal, non-commercial)' };
/** Data health for the note (#147, #148): last good NWS fetch, last failure. */
export const WX_OK_KEY = 'home:wx:lastOk';
export const WX_ERR_KEY = 'home:wx:lastError';
const FORECAST_DONE_KEY = (day: string) => `home:wx:forecast:${day}`;

async function getJson<T>(url: string, label: string, headers: Record<string, string> = {}): Promise<T> {
  let last: unknown = new Error(`${label}: no attempts`);
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, i * 3_000));
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      const body = (await res.json()) as T & { error?: unknown };
      if (body && typeof body === 'object' && 'error' in body && body.error) throw new Error(`${label}: error reply`);
      return body;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Insert an event once; while still un-noted, a newer payload replaces it
 *  (an alert extended, for one). */
export async function upsertEvent(db: Queryable, rule: string, dedupeKey: string, payload: unknown): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO home_event (id, ts, rule, dedupe_key, payload) VALUES ($1, now(), $2, $3, $4)
     ON CONFLICT (dedupe_key) DO UPDATE SET payload = EXCLUDED.payload WHERE home_event.noted_at IS NULL
     RETURNING (xmax = 0) AS inserted`,
    [ulid(), rule, dedupeKey, JSON.stringify(payload)],
  );
  return Boolean(res.rows[0]?.inserted);
}

const fmtWhen = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const when = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? fmtWhen.format(Date.parse(iso)) : null);

interface NwsFeature {
  properties: {
    id?: string;
    event?: string;
    headline?: string;
    severity?: string;
    messageType?: string;
    sent?: string;
    onset?: string | null;
    ends?: string | null;
    expires?: string | null;
    parameters?: { VTEC?: string[] };
  };
}

/** NWS alerts in effect for the (rounded) home point → wx.alert events. */
export async function collectAlerts(db: Queryable, lat: number, lon: number): Promise<number> {
  const body = await getJson<{ features?: NwsFeature[] }>(
    `https://api.weather.gov/alerts/active?point=${coarsen(lat, 1)},${coarsen(lon, 1)}`, 'NWS alerts', UA);
  let n = 0;
  for (const f of body.features ?? []) {
    const p = f.properties;
    if (p.messageType === 'Cancel') continue;
    const event = String(p.event ?? 'Alert');
    const vtec = parseVtec(p.parameters?.VTEC?.[0] ?? '');
    let key: string;
    if (vtec) {
      if (vtec.action === 'CAN' || vtec.action === 'EXP' || !keepAlert(vtec.phen, vtec.sig)) continue;
      key = `wx:alert:${vtec.office}.${vtec.phen}.${vtec.sig}.${vtec.etn}:${String(p.sent ?? p.onset ?? '').slice(0, 4)}`;
    } else {
      if (!keepAlertByName(event) || !p.id) continue;
      key = `wx:alert:${p.id}`;
    }
    const ends = p.ends ?? p.expires ?? null;
    const onset = p.onset ?? null;
    const startsLater = onset !== null && Date.parse(onset) > Date.now() + 30 * 60_000;
    const timing = startsLater
      ? `${when(onset)}${ends ? ` to ${when(ends)}` : ''}`
      : ends ? `until ${when(ends)}` : 'in effect';
    if (await upsertEvent(db, 'wx.alert', key, {
      event, label: event, line: `${event}, ${timing}`, headline: p.headline ?? '', severity: p.severity ?? '',
      onset, ends,
    })) n++;
  }
  return n;
}

/** Season firsts already recorded this season, from their events. */
async function seasonState(db: Queryable, season: string): Promise<SeasonState> {
  const { rows } = await db.query(`SELECT dedupe_key FROM home_event WHERE dedupe_key LIKE $1`, [`wx:first-%:${season}`]);
  const has = (k: string) => rows.some((r) => r.dedupe_key === `wx:${k}:${season}`);
  return { freeze: has('first-freeze'), hardFreeze: has('first-hard-freeze'), snow: has('first-snow') };
}

/** Today's forecast and air → wx.first / wx.extreme / aq.episode events. */
export async function collectForecast(db: Queryable, lat: number, lon: number, today: string): Promise<number> {
  const la = coarsen(lat, 1);
  const lo = coarsen(lon, 1);
  const daily = 'temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,wind_gusts_10m_max';
  const wx = await getJson<{ daily: Record<string, Array<number | null>> & { time: string[] } }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&daily=${daily}` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(TZ)}` +
      `&past_days=1&forecast_days=2`, 'forecast');
  const d = wx.daily;
  const i = d.time.indexOf(today);
  if (i < 1 || i + 1 >= d.time.length) throw new Error(`forecast: no rows around ${today}`);
  const v = (k: string, j: number) => d[k]?.[j] ?? NaN;
  const season = seasonOf(today);
  const { findings } = dayFindings(
    {
      date: today,
      hi: v('temperature_2m_max', i),
      lo: v('temperature_2m_min', i + 1), // tonight's low falls on tomorrow's date
      snow: v('snowfall_sum', i),
      rain: v('precipitation_sum', i),
      gust: v('wind_gusts_10m_max', i),
      prevHi: v('temperature_2m_max', i - 1),
    },
    await seasonState(db, season),
    'tonight',
  );
  let n = 0;
  for (const f of findings) {
    const key = f.rule === 'wx.first' ? `wx:${f.kind}:${season}` : `wx:${f.kind}:${today}`;
    if (await upsertEvent(db, f.rule, key, { kind: f.kind, label: f.label, line: f.line, date: f.date })) n++;
  }

  const aq = await getJson<{ hourly: { time: string[]; us_aqi: Array<number | null> } }>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${la}&longitude=${lo}&hourly=us_aqi` +
      `&timezone=${encodeURIComponent(TZ)}&past_days=1&forecast_days=1`, 'air quality');
  const max = (day: string) =>
    Math.max(-1, ...aq.hourly.time.map((t, j) => (t.startsWith(day) ? aq.hourly.us_aqi[j] ?? -1 : -1)));
  const todayMax = max(today);
  if (aqEpisodeStarts(todayMax, max(addDays(today, -1)))) {
    if (await upsertEvent(db, 'aq.episode', `aq:${today}`, {
      label: 'unhealthy air',
      line: `Air quality unhealthy for sensitive groups today (AQI up to ${todayMax})`,
      date: today,
    })) n++;
  }
  return n;
}

export async function jobHomeWeather(redis: Redis, db: Queryable): Promise<void> {
  const home = await resolveHomeAnchor(redis);
  let alerts: number;
  try {
    alerts = await collectAlerts(db, home.lat, home.lon);
  } catch (err) {
    await redis.set(WX_ERR_KEY, JSON.stringify({ at: Date.now(), error: String(err).slice(0, 200) }));
    throw err;
  }
  await redis.set(WX_OK_KEY, String(Date.now()));
  await redis.del(WX_ERR_KEY);

  // The forecast pass runs once, in the two hours before the note, so the
  // note always reads this morning's forecast.
  const now = Date.now();
  const today = localDay(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  let findings = 0;
  const inWindow = hour >= env.homeNoteHourLocal - 2 && hour < env.homeNoteHourLocal + 4;
  if (inWindow && !(await redis.get(FORECAST_DONE_KEY(today)))) {
    findings = await collectForecast(db, home.lat, home.lon, today);
    await redis.set(FORECAST_DONE_KEY(today), '1', 'EX', 2 * 86400);
  }
  log('home', 'weather run', { alertEvents: alerts, forecastEvents: findings, forecast: inWindow ? 'checked' : 'outside window' });
}
