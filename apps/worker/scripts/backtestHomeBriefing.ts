/**
 * Home-briefing backtest (DECISIONS #143, FOUNDATION §12).
 *
 * Replays the first home-briefing rules over the last N days of public data to
 * test the riskiest assumption before anything is built: does enough change
 * near home to be worth a message more than a couple of times a week?
 *
 *   pnpm --filter @orrery/worker backtest:home -- --lat=<home lat> --lon=<home lon> [--days=90] [--json=out.json]
 *
 * Read-only and keyless; writes nothing but stdout and the optional --json
 * file. The home point is an argument, never a constant: it is personal data
 * and stays out of the repo, and it never leaves the machine either. Weather
 * and alert calls get it rounded to 0.1° (~7 mi). Crime is queried as a box
 * around the point rounded to 0.01°, padded to cover the rounding, and the
 * exact distances are computed here.
 *
 * Sources (verified live 2026-11-08):
 *  - crime: Denver Open Data ArcGIS (ODC_CRIME_OFFENSES_P/324) within 1 mi of
 *    home, plus a year of history as the "normal" each day is compared with.
 *  - weather: Open-Meteo historical-forecast API (archived day-0 forecasts,
 *    i.e. what a morning briefing would actually have seen).
 *  - air quality: Open-Meteo air-quality API (CAMS model, US AQI).
 *  - NWS warnings/watches/advisories: Iowa Environmental Mesonet VTEC archive,
 *    by point (polygon warnings from the storm-based archive, the rest by zone).
 *
 * Known optimism: crime is bucketed by REPORTED_DATE, but Denver publishes
 * Mon–Fri in batches, so a live briefing would see weekend reports on Monday.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
// The live rules (src/home): what is measured here is what runs.
import { coarseBox, distMi } from '../src/home/anchor.js';
import { DENVER_CRIME_URL as CRIME_URL } from '../src/home/crime.js';
import {
  CLUSTER_RADIUS_MI,
  GUNFIRE,
  SERIOUS,
  VIOLENT,
  WALK_RADIUS_MI as CRIME_RADIUS_MI,
  addDays,
  clusterKeys,
  daysBetween,
  localDay as dayOf,
  median,
  nearbyRule,
  stepCluster,
  trailing7,
} from '../src/home/crimeRules.js';
import { aqEpisodeStarts, dayFindings } from '../src/home/weatherRules.js';

const TZ = 'America/Denver';
const SERIOUS_RADII = [0.25, 0.5, 1] as const;
const GUNFIRE_RADII = [0.5, 1] as const;

/** Phenomena issued as storm-based polygons: trust the polygon archive, not
 *  the county the polygon happens to touch. */
const SBW_PHEN = new Set(['TO', 'SV', 'FF', 'FA', 'MA', 'EW', 'SQ', 'DS']);

// ── args ──────────────────────────────────────────────────────────────────
// pnpm forwards its `--` separator literally; drop it so the flags parse.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();
const { values: arg } = parseArgs({
  args: argv,
  options: {
    lat: { type: 'string' },
    lon: { type: 'string' },
    days: { type: 'string', default: '90' },
    end: { type: 'string' },
    json: { type: 'string' },
    detail: { type: 'string', default: 'proposed' },
  },
  allowPositionals: true,
});
const lat = Number(arg.lat ?? process.env.HOME_LAT);
const lon = Number(arg.lon ?? process.env.HOME_LON);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('usage: backtest:home -- --lat=<home lat> --lon=<home lon> [--days=90] [--end=YYYY-MM-DD] [--json=out.json]');
  process.exit(2);
}
const DAYS = Number(arg.days);
const wxLat = Math.round(lat * 10) / 10;
const wxLon = Math.round(lon * 10) / 10;

// ── helpers ───────────────────────────────────────────────────────────────
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

async function getJson<T>(url: string, label: string): Promise<T> {
  let last: unknown = new Error(`${label}: no attempts`);
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2_000 * i));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      if (body && typeof body === 'object' && 'error' in body && (body as { error: unknown }).error) {
        throw new Error(`${label}: ${JSON.stringify(body).slice(0, 200)}`);
      }
      return body as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ── items: what a briefing would have said, per day ──────────────────────
interface Item { day: string; rule: string; text: string }
const items: Item[] = [];
const say = (day: string, rule: string, text: string) => items.push({ day, rule, text });

// ── crime ─────────────────────────────────────────────────────────────────
interface Incident { day: string; cat: string; type: string; distMi: number; address: string; nbhd: string }

async function crimeMaxDay(): Promise<string> {
  const stats = encodeURIComponent(JSON.stringify([
    { statisticType: 'max', onStatisticField: 'REPORTED_DATE', outStatisticFieldName: 'hi' },
  ]));
  const body = await getJson<{ features: Array<{ attributes: { hi: number } }> }>(
    `${CRIME_URL}/query?where=IS_CRIME%3D1&outStatistics=${stats}&f=json`, 'crime max date');
  return dayOf(body.features[0]!.attributes.hi);
}

/** Query box: the live collector's (anchor.ts), so the exact point isn't sent. */
const crimeBox = () => coarseBox({ lat, lon }, CRIME_RADIUS_MI);

async function fetchCrime(since: string): Promise<Incident[]> {
  const meta = await getJson<{ objectIdField?: string; maxRecordCount?: number }>(`${CRIME_URL}?f=json`, 'crime layer');
  const oid = meta.objectIdField ?? 'OBJECTID';
  const page = Math.min(meta.maxRecordCount ?? 1000, 2000);
  const out: Incident[] = [];
  for (let offset = 0; ; offset += page) {
    const p = new URLSearchParams({
      where: `REPORTED_DATE >= DATE '${since}' AND IS_CRIME = 1`,
      outFields: 'OFFENSE_CATEGORY_ID,OFFENSE_TYPE_ID,REPORTED_DATE,INCIDENT_ADDRESS,NEIGHBORHOOD_ID',
      geometry: crimeBox(), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outSR: '4326', returnGeometry: 'true', orderByFields: oid,
      resultOffset: String(offset), resultRecordCount: String(page), f: 'json',
    });
    const body = await getJson<{
      features?: Array<{ attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } }>;
      exceededTransferLimit?: boolean;
    }>(`${CRIME_URL}/query?${p}`, `crime page ${offset / page + 1}`);
    const feats = body.features ?? [];
    for (const f of feats) {
      const a = f.attributes;
      const x = f.geometry?.x, y = f.geometry?.y;
      if (typeof a.REPORTED_DATE !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
      out.push({
        day: dayOf(a.REPORTED_DATE),
        cat: String(a.OFFENSE_CATEGORY_ID ?? 'unknown'),
        type: String(a.OFFENSE_TYPE_ID ?? ''),
        distMi: distMi(lat, lon, y, x),
        address: String(a.INCIDENT_ADDRESS ?? ''),
        nbhd: String(a.NEIGHBORHOOD_ID ?? ''),
      });
      if (out[out.length - 1]!.distMi > CRIME_RADIUS_MI) out.pop(); // box corners
    }
    process.stderr.write(`  crime: ${out.length} rows\r`);
    if (feats.length < page && !body.exceededTransferLimit) break;
  }
  process.stderr.write('\n');
  return out;
}

/** Serious violent offenses within each radius, one item per offense-day. */
function crimeNearby(inc: Incident[], window: string[]) {
  const inWin = new Set(window);
  for (const r of SERIOUS_RADII) {
    for (const i of inc) {
      if (!inWin.has(i.day) || !SERIOUS.has(i.cat) || i.distMi > r) continue;
      say(i.day, `crime.serious.${r}`, `${i.type} at ${i.address || 'an unlisted address'} (${i.distMi.toFixed(2)} mi)`);
    }
  }
  // The panel's current CRIME insert: any VIOLENT (incl. simple assault) ≤ ~1 mi.
  for (const i of inc) {
    if (inWin.has(i.day) && VIOLENT.has(i.cat) && i.distMi <= 1) say(i.day, 'crime.violent.1', `${i.type} (${i.distMi.toFixed(2)} mi)`);
  }
  // Gunfire and homicide: the per-incident tier that stays rarest (run 1).
  for (const r of GUNFIRE_RADII) {
    for (const i of inc) {
      if (inWin.has(i.day) && GUNFIRE.test(i.type) && i.distMi <= r) {
        say(i.day, `crime.gunfire.${r}`, `${i.type} at ${i.address || 'an unlisted address'} (${i.distMi.toFixed(2)} mi)`);
      }
    }
  }
  // The live morning-note rule (crimeRules.nearbyRule, DECISIONS #144).
  for (const i of inc) {
    if (inWin.has(i.day) && nearbyRule({ category: i.cat, type: i.type }, i.distMi)) {
      say(i.day, 'crime.note', `${i.type} at ${i.address || 'an unlisted address'} (${i.distMi.toFixed(2)} mi)`);
    }
  }
}

/** A category's trailing-7-day count within CLUSTER_RADIUS_MI vs the same
 *  statistic over the prior year (median/MAD, FOUNDATION §2). Fires on the
 *  first day it crosses; re-arms once the count is back near normal. */
function crimeClusters(inc: Incident[], allDays: string[], window: string[]) {
  const idx = new Map(allDays.map((d, i) => [d, i]));
  const near = inc.filter((i) => i.distMi <= CLUSTER_RADIUS_MI);
  const keys = new Map<string, number[]>();
  const bump = (k: string, d: string) => {
    let a = keys.get(k);
    if (!a) keys.set(k, (a = new Array(allDays.length).fill(0)));
    const j = idx.get(d);
    if (j !== undefined) a[j]!++;
  };
  for (const i of near) for (const k of clusterKeys(i.cat)) bump(k, i.day);
  const normals: Record<string, number> = {};
  const first = idx.get(window[0]!)!;
  for (const [k, daily] of keys) {
    const t = trailing7(daily);
    let armed = true;
    for (let i = first; i < allDays.length; i++) {
      const step = stepCluster(t, i, armed); // the live detector's step
      if (!step) continue; // not enough history to call anything unusual
      if (i === first) normals[k] = step.levels.median;
      if (step.fire) {
        say(allDays[i]!, 'crime.cluster',
          `${k}: ${step.count} within ½ mi in 7 days (normal ${step.levels.median}, alert at ${Math.ceil(step.levels.alertAt)})`);
      }
      armed = step.armed;
    }
  }
  return normals;
}

// ── weather, air, alerts ──────────────────────────────────────────────────
async function weather(window: string[]) {
  const start = addDays(window[0]!, -1), end = window[window.length - 1]!;
  const daily = 'temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,wind_gusts_10m_max';
  const body = await getJson<{ daily: Record<string, Array<number | null>> & { time: string[] } }>(
    `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${wxLat}&longitude=${wxLon}` +
      `&start_date=${start}&end_date=${end}&daily=${daily}&temperature_unit=fahrenheit&wind_speed_unit=mph` +
      `&precipitation_unit=inch&timezone=${encodeURIComponent(TZ)}`, 'weather');
  const d = body.daily;
  const v = (k: string, i: number) => d[k]?.[i] ?? NaN;
  // The live detector's rules (weatherRules.dayFindings). Season firsts
  // assume the window starts after the summer.
  let season = { freeze: false, hardFreeze: false, snow: false };
  for (let i = 1; i < d.time.length; i++) {
    const r = dayFindings({
      date: d.time[i]!,
      hi: v('temperature_2m_max', i),
      lo: v('temperature_2m_min', i),
      snow: v('snowfall_sum', i),
      rain: v('precipitation_sum', i),
      gust: v('wind_gusts_10m_max', i),
      prevHi: v('temperature_2m_max', i - 1),
    }, season);
    season = r.season;
    for (const f of r.findings) say(f.date, f.rule, f.line);
  }
}

async function airQuality(window: string[]) {
  const start = window[0]!, end = window[window.length - 1]!;
  const base = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${wxLat}&longitude=${wxLon}&hourly=us_aqi&timezone=${encodeURIComponent(TZ)}`;
  const body = await getJson<{ hourly: { time: string[]; us_aqi: Array<number | null> } }>(
    `${base}&start_date=${start}&end_date=${end}`, 'air quality');
  const max = new Map<string, number>();
  body.hourly.time.forEach((t, i) => {
    const a = body.hourly.us_aqi[i];
    if (typeof a === 'number') max.set(t.slice(0, 10), Math.max(max.get(t.slice(0, 10)) ?? 0, a));
  });
  for (const day of window) {
    const a = max.get(day);
    if (a === undefined) continue;
    if (aqEpisodeStarts(a, max.get(addDays(day, -1)) ?? NaN)) {
      say(day, 'aq.episode', `air quality unhealthy for sensitive groups (AQI ${a.toFixed(0)})`);
    }
  }
}

async function nwsAlerts(window: string[]) {
  const sdate = window[0]!, edate = addDays(window[window.length - 1]!, 1);
  const q = `lat=${wxLat}&lon=${wxLon}&sdate=${sdate}&edate=${edate}`;
  const [zone, sbw] = await Promise.all([
    getJson<{ events?: AlertRow[] }>(`https://mesonet.agron.iastate.edu/json/vtec_events_bypoint.py?${q}`, 'NWS zone alerts'),
    getJson<{ sbws?: AlertRow[] }>(`https://mesonet.agron.iastate.edu/json/sbw_by_point.py?${q}`, 'NWS polygon alerts'),
  ]);
  const rows = [
    ...(zone.events ?? []).filter((r) => !SBW_PHEN.has(r.phenomena)),
    ...(sbw.sbws ?? []).filter((r) => SBW_PHEN.has(r.phenomena)),
  ];
  const seen = new Set<string>();
  const inWin = new Set(window);
  for (const r of rows) {
    const key = `${r.wfo}.${r.phenomena}.${r.significance}.${r.eventid}.${r.issue.slice(0, 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = dayOf(Date.parse(r.issue));
    if (!inWin.has(day)) continue;
    const rule =
      r.significance === 'W' ? 'wx.warning'
      : r.significance === 'A' ? 'wx.watch'
      : r.significance === 'Y' ? (r.phenomena === 'FG' ? 'wx.advisory.fog' : 'wx.advisory')
      : null;
    if (rule) say(day, rule, `NWS ${r.name ?? `${r.phenomena}.${r.significance}`}`);
  }
}
interface AlertRow { issue: string; phenomena: string; significance: string; eventid: number; wfo: string; name?: string }

// ── scenarios ─────────────────────────────────────────────────────────────
const SCENARIOS: Record<string, string[]> = {
  /** Run 2: change-vs-normal crime + the rare per-incident tier + weather
   *  that is news rather than season. */
  proposed: ['crime.cluster', 'crime.gunfire.0.5', 'wx.warning', 'wx.advisory', 'wx.first', 'wx.extreme', 'aq.episode'],
  /** Owner's choice (DECISIONS #144): all gunfire and serious violent crime
   *  within the 1-mi walking radius goes in the morning note. */
  owner: ['crime.cluster', 'crime.note', 'wx.warning', 'wx.advisory', 'wx.first', 'wx.extreme', 'aq.episode'],
  'owner, violent ≤ ½ mi': ['crime.cluster', 'crime.gunfire.1', 'crime.serious.0.5', 'wx.warning', 'wx.advisory', 'wx.first', 'wx.extreme', 'aq.episode'],
  tight: ['crime.serious.0.25', 'crime.cluster', 'wx.warning', 'wx.first', 'wx.extreme', 'aq.episode'],
  medium: ['crime.serious.0.5', 'crime.cluster', 'wx.warning', 'wx.watch', 'wx.first', 'wx.extreme', 'aq.episode'],
  loose: ['crime.serious.1', 'crime.cluster', 'wx.warning', 'wx.watch', 'wx.advisory', 'wx.advisory.fog', 'wx.first', 'wx.extreme', 'aq.episode'],
  'panel today (any violent ≤ 1 mi)': ['crime.violent.1'],
};

function summarize(rules: string[], window: string[]) {
  const set = new Set(rules);
  const byDay = new Map<string, Item[]>();
  for (const it of items) if (set.has(it.rule)) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  const weeks = new Map<string, number>();
  for (const d of window) weeks.set(mondayOf(d), (weeks.get(mondayOf(d)) ?? 0) + (byDay.has(d) ? 1 : 0));
  let streak = 0, longest = 0;
  for (const d of window) { streak = byDay.has(d) ? 0 : streak + 1; longest = Math.max(longest, streak); }
  const perWeek = [...weeks.values()];
  return {
    daysWithItems: byDay.size,
    items: [...byDay.values()].reduce((s, a) => s + a.length, 0),
    medianDaysPerWeek: median(perWeek),
    quietWeeks: perWeek.filter((n) => n === 0).length,
    weeks: perWeek.length,
    longestQuietStreak: longest,
    byDay,
  };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const maxDay = await crimeMaxDay();
  // The newest crime day is usually partial (batch publishing), so end the
  // window the day before it unless told otherwise.
  const end = arg.end ?? addDays(maxDay, -1);
  const window = daysBetween(addDays(end, -(DAYS - 1)), end);
  const histStart = addDays(window[0]!, -372);
  console.log(`Home-briefing backtest: ${window[0]} → ${end} (${window.length} days)`);
  console.log(`  crime: Denver Open Data, newest reported day ${maxDay}; history from ${histStart}`);
  console.log(`  weather/alerts at the home point rounded to 0.1°\n`);

  const inc = await fetchCrime(histStart);
  const allDays = daysBetween(histStart, end);
  crimeNearby(inc, window);
  const normals = crimeClusters(inc, allDays, window);
  const failures: string[] = [];
  for (const [label, job] of [
    ['weather', () => weather(window)],
    ['air quality', () => airQuality(window)],
    ['NWS alerts', () => nwsAlerts(window)],
  ] as const) {
    try { await job(); } catch (e) { failures.push(`${label}: ${String(e).slice(0, 160)}`); }
  }

  const inWin = inc.filter((i) => i.day >= window[0]! && i.day <= end);
  console.log(`Crime within ${CRIME_RADIUS_MI} mi in the window: ${inWin.length} offenses (${(inWin.length / window.length).toFixed(1)}/day); within ½ mi: ${inWin.filter((i) => i.distMi <= 0.5).length}`);
  const ocap = new Map<string, number>();
  for (const i of inWin) if (i.cat === 'other-crimes-against-persons') ocap.set(i.type, (ocap.get(i.type) ?? 0) + 1);
  console.log(`  other-crimes-against-persons by type: ${[...ocap].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`  normal 7-day counts within ½ mi at window start: ${Object.entries(normals).sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${m}`).join(', ')}\n`);

  console.log('Per rule (days with ≥1 item / items):');
  const rules = [...new Set(items.map((i) => i.rule))].sort();
  for (const r of rules) {
    const its = items.filter((i) => i.rule === r);
    console.log(`  ${r.padEnd(22)} ${String(new Set(its.map((i) => i.day)).size).padStart(3)} days  ${String(its.length).padStart(4)} items`);
  }
  console.log('\nScenarios:');
  const out: Record<string, unknown> = {};
  for (const [name, rs] of Object.entries(SCENARIOS)) {
    const s = summarize(rs, window);
    out[name] = { ...s, byDay: Object.fromEntries(s.byDay) };
    console.log(`  ${name.padEnd(34)} ${String(s.daysWithItems).padStart(3)}/${window.length} days · median ${s.medianDaysPerWeek} days/week · ${s.quietWeeks}/${s.weeks} quiet weeks · longest quiet run ${s.longestQuietStreak} d`);
  }
  if (failures.length) console.log(`\nSource failures (rules missing from the totals): ${failures.join('; ')}`);

  const detail = SCENARIOS[arg.detail!] ? arg.detail! : 'proposed';
  console.log(`\nDay by day (${detail}):`);
  for (const [day, its] of [...summarize(SCENARIOS[detail]!, window).byDay].sort()) {
    console.log(`  ${day}  ${its.map((i) => i.text).join(' · ')}`);
  }
  if (arg.json) writeFileSync(arg.json, JSON.stringify({ window: [window[0], end], items, scenarios: out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
