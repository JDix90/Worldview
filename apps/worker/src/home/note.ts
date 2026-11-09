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
import { crimeSeries, CLUSTER_RADIUS_MI, WALK_RADIUS_MI } from './crime.js';
import { clusterLevels, localDay, trailing7 } from './crimeRules.js';

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
export interface NoteInput {
  items: NoteItem[];
  clusters: ClusterItem[];
  eventIds: string[];
}
export interface EventRow {
  id: string;
  rule: string;
  payload: Record<string, unknown>;
}

export function assembleNoteInput(rows: EventRow[]): NoteInput {
  const items: NoteItem[] = [];
  const clusters: ClusterItem[] = [];
  const eventIds: string[] = [];
  for (const r of rows) {
    const p = r.payload;
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
  return { items, clusters, eventIds };
}

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
  return [near, up].filter(Boolean).join('; ') + '.';
}

/** The note rendered in code: the fallback, and the shape the model is asked for. */
export function renderPlainNote(input: NoteInput): string {
  const lines = [noteLead(input)];
  const all = [...input.items.map(itemLine), ...input.clusters.map(clusterLine)];
  lines.push(...all.slice(0, MAX_NOTE_LINES).map((l) => `- ${l}`));
  if (all.length > MAX_NOTE_LINES) lines.push(`+${all.length - MAX_NOTE_LINES} more`);
  return lines.join('\n');
}

export const NOTE_SYSTEM = `You write the morning home note for ORRERY, a personal instrument that watches one person's neighborhood in Denver. The owner walks within about a mile of home and wants to know about gunfire and serious violent crime nearby, and about crime running above normal. The note arrives as a phone notification.

Rules:
- First line: one short sentence that sums up the note. No greeting.
- Then one line per item, in the order given: what, where (the block or intersection exactly as given), distance and direction from home, and when it was reported. If an item has an "occurred" time, say when it happened as well.
- Then one line per cluster: what, the count over 7 days, and its normal.
- Use only what is given. No background, causes, speculation, safety advice or reassurance, and don't link incidents to each other.
- Plain text: no markdown, headers or emoji. Under 900 characters; if the lines don't fit, end with how many more there are.`;

export function buildNotePrompt(input: NoteInput): string {
  const { items, clusters } = input;
  return `Write this morning's home note. Distances are miles from home; "dir" is the direction from home.\n\n\`\`\`json\n${JSON.stringify({ items, clusters }, null, 2)}\n\`\`\``;
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
  };
}

const countLine = (c: CountVsNormal) => `${c.what} ${c.count} (normal ${c.normal})${c.unusual ? ', unusually high' : ''}`;

export function renderPlainRoundup(r: RoundupInput): string {
  const lines = [`Week near home, ${dayText(r.windowStart)} to ${dayText(r.windowEnd)} (the city reports late).`];
  const { gunfire, violent } = r.withinOneMile;
  lines.push(`Within ${WALK_RADIUS_MI} mi: ${countLine(gunfire)}; ${countLine(violent)}.`);
  const unusual = r.withinHalfMile.filter((c) => c.unusual);
  // "unusually high" = past the cluster alert line, not merely over the median
  if (unusual.length) lines.push(`Unusually high within ½ mi: ${unusual.map(countLine).join('; ')}.`);
  else lines.push('Nothing unusually high within ½ mi.');
  const rest = r.withinHalfMile.filter((c) => !c.unusual).slice(0, 4);
  if (rest.length) lines.push(`Otherwise: ${rest.map(countLine).join('; ')}.`);
  for (const g of r.gunfire) lines.push(`- ${itemLine(g)}`);
  const fresh = [...r.newItems.map(itemLine), ...r.newClusters.map(clusterLine)];
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
- If newItems or newClusters has anything, add it after a short line such as "Since the last note:", one line each in the same form.
- Report what the data says. Don't guess at causes, give safety advice, or reassure.
- Say once that the city publishes reports late, so the week runs to windowEnd.
- Plain text for a phone notification: no markdown or headers. Under 1,200 characters. End with one dry sign-off line.`;

export function buildRoundupPrompt(r: RoundupInput): string {
  return `Write this week's roundup. Distances are miles from home; "dir" is the direction from home.\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
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
  opts: { quiet: boolean; items: number; model: string | null; eventIds: string[]; title: string },
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
  if (!opts.quiet) {
    const [first, ...rest] = body.split('\n');
    pushed = await pushHome(opts.title.replace('%s', (first ?? '').slice(0, 100)), rest.join('\n').trim() || first || body);
    if (pushed) await db.query(`UPDATE home_note SET pushed = true WHERE id = $1`, [ins.rows[0].id]);
  }
  log('home', `${kind} filed`, { dateLocal, quiet: opts.quiet, items: opts.items, model: opts.model ?? 'plain', pushed });
  return { kind, body, quiet: opts.quiet, model: opts.model, pushed };
}

export async function fileNote(db: Queryable, client: AnalystClient, dateLocal: string, events: EventRow[]): Promise<FiledNote | null> {
  const input = assembleNoteInput(events);
  const n = input.items.length + input.clusters.length;
  if (n === 0) {
    return file(db, dateLocal, 'note', 'Nothing of note near home.', { quiet: true, items: 0, model: null, eventIds: [], title: '' });
  }
  const written = await compose(client, 'home_note', env.homeNoteModel, 'low', NOTE_SYSTEM, buildNotePrompt(input));
  const body = tidy(written ?? renderPlainNote(input));
  return file(db, dateLocal, 'note', body, {
    quiet: false, items: n, model: written ? env.homeNoteModel : null, eventIds: input.eventIds, title: 'Near home: %s',
  });
}

export async function fileRoundup(
  db: Queryable,
  redis: Pick<Redis, 'get'>,
  client: AnalystClient,
  dateLocal: string,
  events: EventRow[],
): Promise<FiledNote | null> {
  const fresh = assembleNoteInput(events);
  const input = await assembleRoundupInput(db, redis, fresh);
  if (!input) return fileNote(db, client, dateLocal, events); // no crime history yet
  const written = await compose(client, 'home_roundup', env.homeRoundupModel, 'medium', ROUNDUP_SYSTEM, buildRoundupPrompt(input));
  const body = tidy(written ?? renderPlainRoundup(input));
  return file(db, dateLocal, 'roundup', body, {
    quiet: false,
    items: fresh.items.length + fresh.clusters.length,
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
  const { rows } = await db.query(`SELECT id, rule, payload FROM home_event WHERE noted_at IS NULL ORDER BY ts`);
  const client = new AnalystClient(db);
  if (monday) await fileRoundup(db, redis, client, dateLocal, rows as EventRow[]);
  else await fileNote(db, client, dateLocal, rows as EventRow[]);
}
