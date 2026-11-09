/**
 * The home note and the Monday roundup (FOUNDATION §12, DECISIONS #144–146):
 * Stage 4 for the home vertical.
 *
 * Code decides whether there is anything to say and gathers it: the note
 * from un-noted home_event rows, the roundup from the same year of daily
 * counts the cluster detector uses. The model only writes it. When the model
 * can't (no key, spend cap, refusal, empty reply, API error), the same facts
 * go out rendered in code, so the note never depends on the model.
 *
 * One note per local day at HOME_NOTE_HOUR_LOCAL, filed by an interval check
 * like the briefing (#93): an appliance that was off at 07:00 files late,
 * not never. Mondays the roundup replaces the note and carries its items, so
 * the phone gets one message, not two.
 */
import type { Redis } from 'ioredis';
import { ulid } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { env } from '../env.js';
import { log, logError } from '../log.js';
import { AnalystClient } from '../analyst/client.js';
import { pushHome } from '../analyst/notify.js';
import { resolveHomeAnchor } from './anchor.js';
import { crimeSeries, CLUSTER_RADIUS_MI, CRIME_ERR_KEY, CRIME_OK_KEY, WALK_RADIUS_MI } from './crime.js';
import { clusterLevels, localDay, trailing7 } from './crimeRules.js';
import { WX_ERR_KEY, WX_OK_KEY } from './weather.js';

const TZ = 'America/Denver';
const MAX_NOTE_LINES = 12;
const MAX_BODY_CHARS = 1800; // ntfy caps a message at 4 KB; phones show far less

// ── plain-language names ──────────────────────────────────────────────────
const TYPE_NAMES: Record<string, string> = {
  'weapon-unlawful-discharge-of': 'Shots fired',
  'weapon-fire-into-occ-bldg': 'Shots fired into an occupied building',
  'weapon-fire-into-occ-veh': 'Shots fired into an occupied vehicle',
  'agg-aslt-shoot': 'Shooting',
  'homicide-other': 'Homicide',
  'homicide-family': 'Homicide',
  'robbery-street': 'Street robbery',
  'robbery-business': 'Business robbery',
  'robbery-residence': 'Home robbery',
  'robbery-car-jacking': 'Carjacking',
  'robbery-purse-snatch-w-force': 'Purse snatching',
  'robbery-bank': 'Bank robbery',
  'aggravated-assault': 'Aggravated assault',
  'aggravated-assault-dv': 'Aggravated assault (domestic)',
  'menacing-felony-w-weap': 'Menacing with a weapon',
};
export function offenseName(type: string): string {
  if (TYPE_NAMES[type]) return TYPE_NAMES[type]!;
  const s = type.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CATEGORY_NAMES: Record<string, string> = {
  'theft-from-motor-vehicle': 'thefts from cars',
  'auto-theft': 'car thefts',
  larceny: 'thefts',
  burglary: 'burglaries',
  robbery: 'robberies',
  'aggravated-assault': 'aggravated assaults',
  'other-crimes-against-persons': 'simple assaults and threats',
  'sexual-assault': 'sexual assaults',
  murder: 'homicides',
  arson: 'arsons',
  'public-disorder': 'public-disorder reports',
  'drug-alcohol': 'drug and alcohol offenses',
  'white-collar-crime': 'fraud and white-collar offenses',
  'all-other-crimes': 'other offenses',
};
export function categoryName(key: string): string {
  return CATEGORY_NAMES[key] ?? key.replace(/-/g, ' ');
}

/** Denver's block-level address in readable form:
 *  "1500 BLOCK MAIN ST" → "1500 block of Main St",
 *  "ELM ST / 4TH AVE" → "Elm St & 4th Ave". */
export function prettyAddress(a: string): string {
  const t = a.trim().replace(/\s+/g, ' ');
  if (!t) return 'an unlisted location';
  return t
    .split(' ')
    .map((w) => {
      if (w === '/') return '&';
      if (/^(BLOCK|BLK)$/i.test(w)) return 'block of';
      if (/^\d+(ST|ND|RD|TH)$/i.test(w)) return w.toLowerCase();
      if (/^\d+$/.test(w) || /^[NSEW]$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

const fmtWhen = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const fmtDayOnly = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
export const whenText = (ms: number): string => fmtWhen.format(ms);
const dayText = (d: string): string => fmtDayOnly.format(Date.parse(`${d}T12:00:00Z`));

// ── the note ──────────────────────────────────────────────────────────────
export interface NoteItem {
  kind: 'gunfire' | 'violent';
  what: string;
  where: string;
  neighborhood: string;
  distMi: number;
  dir: string;
  reported: string;
  /** Set only when the offense happened more than a day before its report. */
  occurred: string | null;
}
export interface ClusterItem {
  what: string;
  count: number;
  normal: number;
  radiusMi: number;
  windowEnd: string;
}
/** A weather or air finding (#148): its words are made by the detector. */
export interface WeatherItem {
  rule: string;
  /** Short form for the lead line, e.g. "Winter Storm Warning". */
  label: string;
  /** The note's line, e.g. "Winter Storm Warning, Tue 5:00 PM to Wed 11:00 AM". */
  line: string;
}
export interface NoteInput {
  items: NoteItem[];
  clusters: ClusterItem[];
  weather: WeatherItem[];
  /** Every event this note accounts for, shown or not (an alert that has
   *  already ended is marked noted without being shown). */
  eventIds: string[];
}
const WEATHER_RULES = new Set(['wx.alert', 'wx.first', 'wx.extreme', 'aq.episode']);
/** Alerts first, then season firsts, extremes and air, in that order. */
const WEATHER_ORDER = ['wx.alert', 'wx.first', 'wx.extreme', 'aq.episode'];
export interface EventRow {
  id: string;
  rule: string;
  payload: Record<string, unknown>;
}

export function assembleNoteInput(rows: EventRow[], nowMs = Date.now()): NoteInput {
  const items: NoteItem[] = [];
  const clusters: ClusterItem[] = [];
  const weather: WeatherItem[] = [];
  const eventIds: string[] = [];
  for (const r of rows) {
    const p = r.payload;
    if (WEATHER_RULES.has(r.rule)) {
      eventIds.push(r.id);
      // An alert that ended before the note is old news: account for it, don't show it.
      const ends = Date.parse(String(p.ends ?? ''));
      if (r.rule === 'wx.alert' && Number.isFinite(ends) && ends <= nowMs) continue;
      weather.push({ rule: r.rule, label: String(p.label ?? ''), line: String(p.line ?? p.label ?? '') });
      continue;
    }
    if (r.rule === 'crime.cluster') {
      clusters.push({
        what: categoryName(String(p.key)),
        count: Number(p.count),
        normal: Number(p.normal),
        radiusMi: Number(p.radiusMi ?? CLUSTER_RADIUS_MI),
        windowEnd: String(p.windowEnd ?? ''),
      });
      eventIds.push(r.id);
      continue;
    }
    if (r.rule !== 'crime.gunfire' && r.rule !== 'crime.violent') continue;
    const rep = Date.parse(String(p.reportedAt));
    const occ = p.occurredAt ? Date.parse(String(p.occurredAt)) : NaN;
    items.push({
      kind: r.rule === 'crime.gunfire' ? 'gunfire' : 'violent',
      what: offenseName(String(p.type ?? '')),
      where: prettyAddress(String(p.address ?? '')),
      neighborhood: String(p.neighborhood ?? ''),
      distMi: Number(p.distMi),
      dir: String(p.dir ?? ''),
      reported: Number.isFinite(rep) ? whenText(rep) : 'recently',
      occurred: Number.isFinite(occ) && Number.isFinite(rep) && rep - occ > 86_400_000 ? whenText(occ) : null,
    });
    eventIds.push(r.id);
  }
  // gunfire first, then other violent crime, each nearest first (FOUNDATION §12)
  items.sort((a, b) => (a.kind === b.kind ? a.distMi - b.distMi : a.kind === 'gunfire' ? -1 : 1));
  weather.sort((a, b) => WEATHER_ORDER.indexOf(a.rule) - WEATHER_ORDER.indexOf(b.rule));
  return { items, clusters, weather, eventIds };
}

/** How many things a note has to say. */
export const noteCount = (i: NoteInput): number => i.items.length + i.clusters.length + i.weather.length;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ring = (mi: number) => (mi === 0.5 ? '½ mi' : `${mi} mi`);
const itemLine = (i: NoteItem) =>
  `${i.what}, ${i.where}, ${i.distMi.toFixed(2)} mi ${i.dir}`.trimEnd() +
  (i.occurred ? ` (happened ${i.occurred}, reported ${i.reported})` : ` (reported ${i.reported})`);
const clusterLine = (c: ClusterItem) => `${c.what} within ${ring(c.radiusMi)}: ${c.count} in 7 days, normal ${c.normal}`;

export function noteLead(input: NoteInput): string {
  const g = input.items.filter((i) => i.kind === 'gunfire').length;
  const v = input.items.length - g;
  const parts: string[] = [];
  if (g) parts.push(plural(g, 'gunfire report', 'gunfire reports'));
  if (v) parts.push(plural(v, 'violent crime', 'violent crimes'));
  const near = parts.length ? `${parts.join(' and ')} within a mile` : '';
  const up = input.clusters.map((c) => `${c.what} up`).join(', ');
  const wx = input.weather.map((w) => w.label).filter(Boolean).join(', ');
  const lead = [near, up, wx].filter(Boolean).join('; ');
  return lead.charAt(0).toUpperCase() + lead.slice(1) + '.';
}

/** The note rendered in code: the fallback, and the shape the model is asked for. */
export function renderPlainNote(input: NoteInput): string {
  const lines = [noteLead(input)];
  const all = [...input.items.map(itemLine), ...input.clusters.map(clusterLine), ...input.weather.map((w) => w.line)];
  lines.push(...all.slice(0, MAX_NOTE_LINES).map((l) => `- ${l}`));
  if (all.length > MAX_NOTE_LINES) lines.push(`+${all.length - MAX_NOTE_LINES} more`);
  return lines.join('\n');
}

export const NOTE_SYSTEM = `You write the morning home note for ORRERY, a personal instrument that watches one person's neighborhood in Denver. The owner walks within about a mile of home and wants to know about gunfire and serious violent crime nearby, crime running above normal, and weather worth knowing about today. The note arrives as a phone notification.

Rules:
- First line: one short sentence that sums up the note. No greeting.
- Then one line per item, in the order given: what, where (the block or intersection exactly as given), distance and direction from home, and when it was reported. If an item has an "occurred" time, say when it happened as well.
- Then one line per cluster: what, the count over 7 days, and its normal.
- Then one line per weather entry, keeping its facts and times exactly as given.
- Use only what is given. No background, causes, speculation, safety advice or reassurance, and don't link incidents to each other.
- Plain text: no markdown, headers or emoji. Under 900 characters; if the lines don't fit, end with how many more there are.`;

export function buildNotePrompt(input: NoteInput): string {
  const { items, clusters } = input;
  const weather = input.weather.map((w) => w.line);
  return `Write this morning's home note. Distances are miles from home; "dir" is the direction from home.\n\n\`\`\`json\n${JSON.stringify({ items, clusters, weather }, null, 2)}\n\`\`\``;
}

// ── the roundup ───────────────────────────────────────────────────────────
export interface CountVsNormal {
  what: string;
  count: number;
  normal: number;
  unusual: boolean;
}
export interface RoundupInput {
  /** Reported days covered (the city publishes late, so not "last 7 days"). */
  windowStart: string;
  windowEnd: string;
  withinOneMile: { gunfire: CountVsNormal; violent: CountVsNormal };
  withinHalfMile: CountVsNormal[];
  gunfire: NoteItem[];
  flagged: ClusterItem[];
  /** Items not yet in a note: Monday's roundup carries them. */
  newItems: NoteItem[];
  newClusters: ClusterItem[];
  newWeather: string[];
  /** The week's weather and air findings, e.g. "first freeze tonight (Tue, Nov 3)". */
  weatherWeek: string[];
}

function vsNormal(what: string, daily: number[] | undefined, last: number): CountVsNormal {
  const t7 = trailing7(daily ?? new Array<number>(last + 1).fill(0));
  const lv = clusterLevels(t7.slice(Math.max(6, last - 371), last - 6).filter(Number.isFinite));
  const count = t7[last] ?? 0;
  return { what, count, normal: lv?.median ?? 0, unusual: lv ? count >= lv.alertAt : false };
}

export async function assembleRoundupInput(db: Queryable, redis: Pick<Redis, 'get'>, fresh: NoteInput): Promise<RoundupInput | null> {
  const home = await resolveHomeAnchor(redis);
  const s = await crimeSeries(db, home);
  if (!s) return null;
  const last = s.days.length - 1;
  const half = [...s.ring.entries()]
    .filter(([k]) => k !== 'all property crime' && k !== 'all violent crime')
    .map(([k, daily]) => vsNormal(categoryName(k), daily, last))
    .filter((c) => c.count > 0 || c.normal > 0)
    .sort((a, b) => Math.abs(b.count - b.normal) - Math.abs(a.count - a.normal));
  const week = await db.query(
    `SELECT id, rule, payload FROM home_event WHERE ts >= now() - interval '7 days' AND rule IN ('crime.gunfire', 'crime.cluster') ORDER BY ts`,
  );
  const past = assembleNoteInput(week.rows as EventRow[]);
  const wx = await db.query(
    `SELECT ts, payload->>'label' AS label FROM home_event
     WHERE ts >= now() - interval '7 days' AND rule IN ('wx.alert', 'wx.first', 'wx.extreme', 'aq.episode') ORDER BY ts`,
  );
  return {
    windowStart: s.days[Math.max(0, last - 6)]!,
    windowEnd: s.newest,
    withinOneMile: {
      gunfire: vsNormal('gunfire reports', s.walk.get('crime.gunfire'), last),
      violent: vsNormal('other serious violent crimes', s.walk.get('crime.violent'), last),
    },
    withinHalfMile: half,
    gunfire: past.items,
    flagged: past.clusters,
    newItems: fresh.items,
    newClusters: fresh.clusters,
    newWeather: fresh.weather.map((w) => w.line),
    weatherWeek: wx.rows.map((r) => `${r.label} (${dayText(localDay(new Date(r.ts).getTime()))})`),
  };
}

const countLine = (c: CountVsNormal) => `${c.what} ${c.count} (normal ${c.normal})${c.unusual ? ', unusually high' : ''}`;

export function renderPlainRoundup(r: RoundupInput): string {
  const { gunfire, violent } = r.withinOneMile;
  const unusual = r.withinHalfMile.filter((c) => c.unusual);
  // The first line is the push title's text (after "Week near home: "), so
  // it leads with the verdict, not the date range.
  const lead = [
    `${plural(gunfire.count, 'gunfire report', 'gunfire reports')} within a mile (normal ${gunfire.normal})`,
    unusual.length ? `${unusual.map((c) => c.what).join(', ')} unusually high` : 'nothing unusually high nearby',
  ].join('; ');
  const lines = [`${lead.charAt(0).toUpperCase()}${lead.slice(1)}.`];
  lines.push(`Reports from ${dayText(r.windowStart)} to ${dayText(r.windowEnd)} (the city reports late).`);
  lines.push(`Within ${WALK_RADIUS_MI} mi: ${countLine(gunfire)}; ${countLine(violent)}.`);
  // "unusually high" = past the cluster alert line, not merely over the median
  if (unusual.length) lines.push(`Unusually high within ½ mi: ${unusual.map(countLine).join('; ')}.`);
  else lines.push('Nothing unusually high within ½ mi.');
  const rest = r.withinHalfMile.filter((c) => !c.unusual).slice(0, 4);
  if (rest.length) lines.push(`Otherwise: ${rest.map(countLine).join('; ')}.`);
  for (const g of r.gunfire) lines.push(`- ${itemLine(g)}`);
  if (r.weatherWeek.length) lines.push(`Weather this week: ${r.weatherWeek.join('; ')}.`);
  const fresh = [...r.newItems.map(itemLine), ...r.newClusters.map(clusterLine), ...r.newWeather];
  if (fresh.length) {
    lines.push('Since the last note:');
    lines.push(...fresh.slice(0, MAX_NOTE_LINES).map((l) => `- ${l}`));
    if (fresh.length > MAX_NOTE_LINES) lines.push(`+${fresh.length - MAX_NOTE_LINES} more`);
  }
  return lines.join('\n');
}

export const ROUNDUP_SYSTEM = `You write the Monday roundup for ORRERY, a personal instrument that watches one person's neighborhood in Denver: the past week of crime near home against what a normal week looks like. Voice: a night-watch duty officer filing the week. Laconic, dry, unhurried; never breathless, no exclamation points, no emoji. Any dryness is about the instrument or the statistics, never about victims or violence.

Rules:
- Lead with what changed against normal, then what stayed normal. A quiet week gets one or two sentences saying so.
- Every count comes with its normal, a typical week over the past year: "5 car break-ins within half a mile, normal is 6."
- Give each gunfire report its own line: what, where, distance and direction, when.
- If weatherWeek has entries, give the week's weather one short line, keeping the facts as given.
- If newItems, newClusters or newWeather has anything, add it after a short line such as "Since the last note:", one line each in the same form.
- Report what the data says. Don't guess at causes, give safety advice, or reassure.
- Say once that the city publishes reports late, so the week runs to windowEnd.
- Plain text for a phone notification: no markdown or headers. Under 1,200 characters. End with one dry sign-off line.`;

export function buildRoundupPrompt(r: RoundupInput): string {
  return `Write this week's roundup. Distances are miles from home; "dir" is the direction from home.\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
}

// ── data health (DECISIONS #147) ─────────────────────────────────────────
// FOUNDATION §2's data-health rule, applied to home: a quiet note must mean
// "nothing happened", never "nothing arrived".

/** The collector runs every 3 h; four missed runs is a broken collector. */
export const COLLECTOR_STALE_MS = 12 * 3600_000;
/** Denver publishes Mon–Fri a day or two late, so Monday's newest report is
 *  often Thursday's (4 days). Older than this is no longer normal lag. */
export const UPSTREAM_STALE_DAYS = 5;
const HEALTH_LATCH = 'home:health:notified';

export type CrimeHealth =
  | { state: 'never' }
  | { state: 'fresh' }
  | { state: 'stale'; reason: 'collector' | 'upstream'; since: string; text: string };

export function crimeHealth(o: {
  nowMs: number;
  rows: number;
  newestReportedMs: number | null;
  lastOkMs: number | null;
  lastErrorMs: number | null;
}): CrimeHealth {
  if (o.rows === 0 || o.newestReportedMs === null) {
    // Nothing collected yet. A recorded failure means Denver can't be
    // reached; otherwise the first run simply hasn't finished, so wait.
    return o.lastErrorMs === null
      ? { state: 'never' }
      : { state: 'stale', reason: 'collector', since: 'never',
          text: "Crime data is unavailable: orrery hasn't been able to load Denver's crime data yet." };
  }
  if (o.lastOkMs !== null && o.nowMs - o.lastOkMs > COLLECTOR_STALE_MS) {
    return { state: 'stale', reason: 'collector', since: String(o.lastOkMs),
      text: `Crime data is out of date: orrery hasn't reached Denver's crime data since ${whenText(o.lastOkMs)}.` };
  }
  const newest = localDay(o.newestReportedMs);
  const ageDays = (Date.parse(`${localDay(o.nowMs)}T12:00:00Z`) - Date.parse(`${newest}T12:00:00Z`)) / 86_400_000;
  if (ageDays > UPSTREAM_STALE_DAYS) {
    return { state: 'stale', reason: 'upstream', since: newest,
      text: `Crime data is out of date: Denver's newest published reports are from ${dayText(newest)}.` };
  }
  return { state: 'fresh' };
}

export async function loadCrimeHealth(db: Queryable, redis: Pick<Redis, 'get'>): Promise<CrimeHealth> {
  const { rows } = await db.query(`SELECT count(*)::int AS n, max(reported_at) AS hi FROM home_crime`);
  const ok = Number(await redis.get(CRIME_OK_KEY));
  let errAt: number | null = null;
  try {
    const raw = await redis.get(CRIME_ERR_KEY);
    if (raw) errAt = Number((JSON.parse(raw) as { at?: unknown }).at) || null;
  } catch {
    /* unreadable error record: treat as none */
  }
  return crimeHealth({
    nowMs: Date.now(),
    rows: Number(rows[0]?.n ?? 0),
    newestReportedMs: rows[0]?.hi ? new Date(rows[0].hi).getTime() : null,
    lastOkMs: Number.isFinite(ok) && ok > 0 ? ok : null,
    lastErrorMs: errAt,
  });
}

/** One data source the note can't vouch for today (crime or weather). */
export interface StaleIssue {
  reason: string;
  since: string;
  text: string;
}

/** Weather data health (#148), the same idea for the NWS alerts the note
 *  relies on. Unlike crime, weather never holds the note back: no record at
 *  all (first boot) just means nothing to say yet. */
export function weatherIssue(o: { nowMs: number; lastOkMs: number | null; lastErrorMs: number | null }): StaleIssue | null {
  if (o.lastOkMs === null) {
    return o.lastErrorMs === null
      ? null
      : { reason: 'weather', since: 'never',
          text: "Weather alerts are unavailable: orrery hasn't been able to reach the National Weather Service." };
  }
  if (o.nowMs - o.lastOkMs > COLLECTOR_STALE_MS) {
    return { reason: 'weather', since: String(o.lastOkMs),
      text: `Weather alerts are out of date: orrery hasn't reached the National Weather Service since ${whenText(o.lastOkMs)}.` };
  }
  return null;
}

export async function loadWeatherIssue(redis: Pick<Redis, 'get'>): Promise<StaleIssue | null> {
  const ok = Number(await redis.get(WX_OK_KEY));
  let errAt: number | null = null;
  try {
    const raw = await redis.get(WX_ERR_KEY);
    if (raw) errAt = Number((JSON.parse(raw) as { at?: unknown }).at) || null;
  } catch {
    /* unreadable error record: treat as none */
  }
  return weatherIssue({ nowMs: Date.now(), lastOkMs: Number.isFinite(ok) && ok > 0 ? ok : null, lastErrorMs: errAt });
}

/** True the first time a given set of outages is announced; later notes in
 *  the same outage still say it, but don't push for it alone. */
async function firstNotice(redis: Pick<Redis, 'get' | 'set'>, issues: StaleIssue[]): Promise<boolean> {
  const key = issues.map((h) => `${h.reason}:${h.since}`).join('|');
  if ((await redis.get(HEALTH_LATCH)) === key) return false;
  await redis.set(HEALTH_LATCH, key);
  return true;
}

/** Health lines go right after the lead, so they show in the push body.
 *  Added in code, never by the model, so they can't be reworded or dropped. */
export function withHealthLine(body: string, issues: StaleIssue[]): string {
  if (!issues.length) return body;
  const [lead, ...rest] = body.split('\n');
  return [lead, ...issues.map((h) => h.text), ...rest].join('\n');
}

// ── writing and filing ────────────────────────────────────────────────────
/** Strip markdown the phone would show literally, and cap the length. */
export function tidy(text: string): string {
  let t = text
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > MAX_BODY_CHARS) {
    const cut = t.lastIndexOf('\n', MAX_BODY_CHARS);
    t = `${t.slice(0, cut > 0 ? cut : MAX_BODY_CHARS).trimEnd()}\n…`;
  }
  return t;
}

/** The model's version, or null when the code's version must go out instead. */
async function compose(
  client: AnalystClient,
  kind: 'home_note' | 'home_roundup',
  model: string,
  effort: 'low' | 'medium',
  system: string,
  prompt: string,
): Promise<string | null> {
  if (!client.configured) return null;
  try {
    if (await client.breakerTripped()) {
      log('home', `${kind}: spend cap reached, filing the plain version`);
      return null;
    }
    // Adaptive thinking stays on (these models don't take "disabled" at every
    // effort); low/medium effort keeps it short. 16k is a ceiling, not a spend
    // (the briefing lost two days to a 1,200 cap, #93).
    const res = await client.call(kind, {
      model,
      max_tokens: 16000,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stopReason === 'refusal') {
      log('home', `${kind}: model declined, filing the plain version`);
      return null;
    }
    const text = res.content
      .filter((b): b is Extract<(typeof res.content)[number], { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || null;
  } catch (err) {
    logError('home', `${kind}: model call failed, filing the plain version`, err);
    return null;
  }
}

export interface FiledNote {
  kind: 'note' | 'roundup';
  body: string;
  quiet: boolean;
  model: string | null;
  pushed: boolean;
}

async function file(
  db: Queryable,
  dateLocal: string,
  kind: 'note' | 'roundup',
  body: string,
  opts: { quiet: boolean; items: number; model: string | null; eventIds: string[]; title: string; push?: boolean },
): Promise<FiledNote | null> {
  const ins = await db.query(
    `INSERT INTO home_note (id, date_local, kind, ts, body, quiet, items, model)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7)
     ON CONFLICT (date_local, kind) DO NOTHING RETURNING id`,
    [ulid(), dateLocal, kind, body, opts.quiet, opts.items, opts.model],
  );
  if (ins.rows.length === 0) return null; // another run filed it first
  if (opts.eventIds.length) {
    await db.query(`UPDATE home_event SET noted_at = now() WHERE id = ANY($1::text[])`, [opts.eventIds]);
  }
  let pushed = false;
  if (!opts.quiet && opts.push !== false) {
    const [first, ...rest] = body.split('\n');
    pushed = await pushHome(opts.title.replace('%s', (first ?? '').slice(0, 100)), rest.join('\n').trim() || first || body);
    if (pushed) await db.query(`UPDATE home_note SET pushed = true WHERE id = $1`, [ins.rows[0].id]);
  }
  log('home', `${kind} filed`, { dateLocal, quiet: opts.quiet, items: opts.items, model: opts.model ?? 'plain', pushed });
  return { kind, body, quiet: opts.quiet, model: opts.model, pushed };
}

export async function fileNote(
  db: Queryable,
  redis: Pick<Redis, 'get' | 'set'>,
  client: AnalystClient,
  dateLocal: string,
  events: EventRow[],
  issues: StaleIssue[] = [],
): Promise<FiledNote | null> {
  const input = assembleNoteInput(events);
  const n = noteCount(input);
  if (n === 0 && issues.length) {
    // Not a quiet day: the data didn't arrive. Say so; push once per outage.
    const push = await firstNotice(redis, issues);
    return file(db, dateLocal, 'note', issues.map((h) => h.text).join('\n'), {
      quiet: false, items: 0, model: null, eventIds: input.eventIds, title: 'Near home: %s', push,
    });
  }
  if (n === 0) {
    return file(db, dateLocal, 'note', 'Nothing of note near home.', { quiet: true, items: 0, model: null, eventIds: input.eventIds, title: '' });
  }
  const written = await compose(client, 'home_note', env.homeNoteModel, 'low', NOTE_SYSTEM, buildNotePrompt(input));
  const body = withHealthLine(tidy(written ?? renderPlainNote(input)), issues);
  return file(db, dateLocal, 'note', body, {
    quiet: false, items: n, model: written ? env.homeNoteModel : null, eventIds: input.eventIds, title: 'Near home: %s',
  });
}

export async function fileRoundup(
  db: Queryable,
  redis: Pick<Redis, 'get' | 'set'>,
  client: AnalystClient,
  dateLocal: string,
  events: EventRow[],
  issues: StaleIssue[] = [],
): Promise<FiledNote | null> {
  const fresh = assembleNoteInput(events);
  const input = await assembleRoundupInput(db, redis, fresh);
  if (!input) return fileNote(db, redis, client, dateLocal, events, issues); // no crime history yet
  const written = await compose(client, 'home_roundup', env.homeRoundupModel, 'medium', ROUNDUP_SYSTEM, buildRoundupPrompt(input));
  const body = withHealthLine(tidy(written ?? renderPlainRoundup(input)), issues);
  return file(db, dateLocal, 'roundup', body, {
    quiet: false,
    items: noteCount(fresh),
    model: written ? env.homeRoundupModel : null,
    eventIds: fresh.eventIds,
    title: 'Week near home: %s',
  });
}

/** Interval-scheduled guard: files today's note (Mondays, the roundup) once
 *  past the local note hour. */
export async function jobHomeNoteCheck(redis: Redis, db: Queryable): Promise<void> {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hour < env.homeNoteHourLocal) return;
  const dateLocal = localDay(now.getTime());
  const monday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now) === 'Mon';
  const kind = monday ? 'roundup' : 'note';
  const done = await db.query(`SELECT 1 FROM home_note WHERE date_local = $1 AND kind = $2`, [dateLocal, kind]);
  if (done.rows.length) return;
  const crime = await loadCrimeHealth(db, redis);
  if (crime.state === 'never') {
    // First boot: the backfill hasn't finished. Filing now would record a
    // "quiet" day that is really "no data yet" (DECISIONS #147); check again
    // in 15 minutes.
    log('home', 'note waits: crime data not collected yet');
    return;
  }
  const wx = await loadWeatherIssue(redis);
  const issues: StaleIssue[] = [...(crime.state === 'stale' ? [crime] : []), ...(wx ? [wx] : [])];
  if (!issues.length) await redis.del(HEALTH_LATCH); // outage over: the next one gets announced
  const { rows } = await db.query(`SELECT id, rule, payload FROM home_event WHERE noted_at IS NULL ORDER BY ts`);
  const client = new AnalystClient(db);
  if (monday) await fileRoundup(db, redis, client, dateLocal, rows as EventRow[], issues);
  else await fileNote(db, redis, client, dateLocal, rows as EventRow[], issues);
}
