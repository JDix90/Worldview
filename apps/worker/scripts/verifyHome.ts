/**
 * Home-briefing detector checks (FOUNDATION §12, DECISIONS #143–144).
 * Synthetic data only, at a public Denver anchor (the City and County
 * Building, the code's default): no real near-home rows belong in the repo.
 *
 *   pnpm --filter @orrery/worker verify:home            # pure checks
 *   pnpm --filter @orrery/worker verify:home -- --live  # + one real Denver fetch, no DB
 */
import { priceOf } from '../src/analyst/client.js';
import { coarseBox, coarsen, distMi } from '../src/home/anchor.js';
import {
  assembleNoteInput,
  buildNotePrompt,
  categoryName,
  crimeHealth,
  noteLead,
  withHealthLine,
  offenseName,
  renderPlainNote,
  renderPlainRoundup,
  tidy,
  type RoundupInput,
} from '../src/home/note.js';
import {
  CLUSTER_RADIUS_MI,
  WALK_RADIUS_MI,
  clusterLevels,
  nearbyRule,
  stepCluster,
  trailing7,
} from '../src/home/crimeRules.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const PUBLIC = { lat: 39.7392, lon: -104.9903 };
/** A point `mi` miles due north of the anchor. */
const north = (mi: number) => ({ lat: PUBLIC.lat + mi / 69.05, lon: PUBLIC.lon });

// ── privacy: the query box ────────────────────────────────────────────────
{
  const precise = { lat: 39.68153, lon: -104.96217 }; // arbitrary synthetic point
  const box = coarseBox(precise, WALK_RADIUS_MI);
  const [x0, y0, x1, y1] = box.split(',').map(Number) as [number, number, number, number];
  check('box: carries no more than 3 decimals', box.split(',').every((v) => (v.split('.')[1] ?? '').length <= 3), box);
  check('box: centred on the 0.01° anchor, not the precise point',
    Math.abs((y0 + y1) / 2 - coarsen(precise.lat, 2)) < 0.0006 && Math.abs((x0 + x1) / 2 - coarsen(precise.lon, 2)) < 0.0006);
  // the 1-mi circle around the precise point must fit inside the box
  const reachLat = WALK_RADIUS_MI / 69.05;
  const reachLon = WALK_RADIUS_MI / (69.17 * Math.cos((precise.lat * Math.PI) / 180));
  check('box: covers the full walking radius around the precise point',
    y0 <= precise.lat - reachLat && y1 >= precise.lat + reachLat && x0 <= precise.lon - reachLon && x1 >= precise.lon + reachLon);
}

// ── nearby rule (owner: every gunfire and serious violent offense ≤ 1 mi) ─
{
  const d = (p: { lat: number; lon: number }) => distMi(PUBLIC.lat, PUBLIC.lon, p.lat, p.lon);
  check('nearby: shots fired with no one hit at 0.8 mi → gunfire',
    nearbyRule({ category: 'all-other-crimes', type: 'weapon-unlawful-discharge-of' }, d(north(0.8))) === 'crime.gunfire');
  check('nearby: shooting assault at 0.3 mi → gunfire, not violent',
    nearbyRule({ category: 'aggravated-assault', type: 'agg-aslt-shoot' }, d(north(0.3))) === 'crime.gunfire');
  check('nearby: robbery at 0.9 mi → violent',
    nearbyRule({ category: 'robbery', type: 'robbery-street' }, d(north(0.9))) === 'crime.violent');
  check('nearby: robbery at 1.2 mi → nothing',
    nearbyRule({ category: 'robbery', type: 'robbery-street' }, d(north(1.2))) === null);
  check('nearby: simple assault at 0.2 mi → nothing (not serious)',
    nearbyRule({ category: 'other-crimes-against-persons', type: 'assault-simple' }, d(north(0.2))) === null);
  check('nearby: car break-in at 0.1 mi → nothing (counts toward clusters only)',
    nearbyRule({ category: 'theft-from-motor-vehicle', type: 'theft-items-from-vehicle' }, d(north(0.1))) === null);
  check('nearby: unknown distance → nothing', nearbyRule({ category: 'robbery', type: 'robbery-street' }, NaN) === null);
}

// ── cluster rule (#143 b) ─────────────────────────────────────────────────
{
  check('cluster: needs ~half a year of history', clusterLevels(new Array(100).fill(3)) === null);
  // A year of a steady ~3/week category (one offense every other day or so).
  const daily: number[] = [];
  for (let i = 0; i < 380; i++) daily.push(i % 7 === 0 || i % 7 === 3 || i % 7 === 5 ? 1 : 0);
  const quiet = trailing7(daily);
  const q = stepCluster(quiet, daily.length - 1, true);
  check('cluster: a normal week does not fire', q !== null && !q.fire, q ? `count ${q.count}, alert at ${q.levels.alertAt}` : '');

  // Spike: 10 in the last 7 days.
  const spiked = [...daily.slice(0, -7), 2, 1, 2, 1, 2, 1, 1];
  const t = trailing7(spiked);
  const s1 = stepCluster(t, spiked.length - 1, true);
  check('cluster: a 10-in-7-days spike against a normal of 3 fires', s1 !== null && s1.fire && !s1.armed,
    s1 ? `count ${s1.count}, normal ${s1.levels.median}, alert at ${s1.levels.alertAt}` : '');
  const s2 = stepCluster(t, spiked.length - 1, false);
  check('cluster: still high next run while latched → no second event', s2 !== null && !s2.fire && !s2.armed);
  const calm = trailing7([...spiked, 0, 0, 0, 0, 0, 0, 0]);
  const s3 = stepCluster(calm, spiked.length + 6, false);
  check('cluster: back to normal → re-armed', s3 !== null && !s3.fire && s3.armed);
}

check('constants: walking radius 1 mi, cluster ring ½ mi', WALK_RADIUS_MI === 1 && CLUSTER_RADIUS_MI === 0.5);

// ── the note (H4): assembly, plain rendering, tidying ─────────────────────
{
  const ev = (id: string, rule: string, payload: Record<string, unknown>) => ({ id, rule, payload });
  const rows = [
    ev('a', 'crime.violent', { type: 'robbery-street', address: '1500 BLOCK MAIN ST', distMi: 0.9, dir: 'N', reportedAt: '2026-11-03T03:00:00Z' }),
    ev('b', 'crime.gunfire', { type: 'weapon-unlawful-discharge-of', address: 'ELM ST / 4TH AVE', distMi: 0.7, dir: 'E', reportedAt: '2026-11-03T05:00:00Z' }),
    ev('c', 'crime.violent', { type: 'aggravated-assault', address: '200 BLK OAK ST', distMi: 0.2, dir: 'SW',
      reportedAt: '2026-11-03T06:00:00Z', occurredAt: '2026-10-30T06:00:00Z' }),
    ev('d', 'crime.cluster', { key: 'auto-theft', count: 8, normal: 3, radiusMi: 0.5, windowEnd: '2026-11-02' }),
    ev('e', 'some.other.rule', {}),
  ];
  const input = assembleNoteInput(rows);
  check('note: gunfire first, then violent nearest first',
    input.items.map((i) => i.what).join('|') === 'Shots fired|Aggravated assault|Street robbery', input.items.map((i) => i.what).join('|'));
  check('note: unknown rules are ignored and not marked noted', input.eventIds.length === 4 && !input.eventIds.includes('e'));
  check('note: an offense reported days later says when it happened',
    input.items[1]!.occurred !== null && input.items[0]!.occurred === null);
  check('note: plain-language address', input.items[0]!.where === 'Elm St & 4th Ave' && input.items[1]!.where === '200 block of Oak St',
    `${input.items[0]!.where} / ${input.items[1]!.where}`);
  check('note: lead counts gunfire, violence and clusters',
    noteLead(input) === '1 gunfire report and 2 violent crimes within a mile; car thefts up.', noteLead(input));
  const plain = renderPlainNote(input);
  check('note: plain version has the lead plus one line per item and cluster', plain.split('\n').length === 5);
  check('note: no coordinates in what the model sees',
    !/lat|lon|39\.|104\./.test(buildNotePrompt(input)));
  check('tidy: strips markdown the phone would show literally', tidy('# Head\n**bold** and `code`') === 'Head\nbold and code');
  check('tidy: caps the length on a line boundary', tidy('x'.repeat(100) + '\n' + 'y'.repeat(2000)).length < 200);
  check('names: fallback for an unmapped type', offenseName('robbery-armored-car') === 'Robbery armored car');
  check('names: category', categoryName('theft-from-motor-vehicle') === 'thefts from cars');
}

// ── the roundup (H4): plain rendering ─────────────────────────────────────
{
  const r: RoundupInput = {
    windowStart: '2026-10-27', windowEnd: '2026-11-02',
    withinOneMile: {
      gunfire: { what: 'gunfire reports', count: 3, normal: 1, unusual: false },
      violent: { what: 'other serious violent crimes', count: 12, normal: 13, unusual: false },
    },
    withinHalfMile: [
      { what: 'car thefts', count: 8, normal: 3, unusual: true },
      { what: 'thefts', count: 14, normal: 15, unusual: false },
    ],
    gunfire: [], flagged: [], newItems: [], newClusters: [],
  };
  const text = renderPlainRoundup(r);
  check('roundup: counts carry their normal', text.includes('gunfire reports 3 (normal 1)') && text.includes('car thefts 8 (normal 3), unusually high'));
  check('roundup: says the city reports late', /reports late/.test(text));
}

// ── data health (DECISIONS #147): quiet must mean "nothing happened" ──────
{
  const H = 3600_000;
  const now = Date.parse('2026-11-09T14:00:00Z'); // Monday 07:00 in Denver
  const day = (iso: string) => Date.parse(`${iso}T18:00:00Z`);
  const base = { nowMs: now, rows: 20_000, lastOkMs: now - 2 * H, lastErrorMs: null };
  check('health: first boot, nothing collected, no error → wait (never)',
    crimeHealth({ ...base, rows: 0, newestReportedMs: null, lastOkMs: null }).state === 'never');
  const unreachable = crimeHealth({ ...base, rows: 0, newestReportedMs: null, lastOkMs: null, lastErrorMs: now - H });
  check('health: nothing collected and a recorded failure → unavailable', unreachable.state === 'stale' && /unavailable/.test(unreachable.state === 'stale' ? unreachable.text : ''));
  check('health: Monday with Thursday\'s reports newest → normal lag, fresh',
    crimeHealth({ ...base, newestReportedMs: day('2026-11-05') }).state === 'fresh');
  const upstream = crimeHealth({ ...base, newestReportedMs: day('2026-11-02') });
  check('health: newest reports a week old → Denver not publishing',
    upstream.state === 'stale' && upstream.reason === 'upstream' && /Denver's newest published reports are from Mon, Nov 2/.test(upstream.text),
    upstream.state === 'stale' ? upstream.text : '');
  const collector = crimeHealth({ ...base, newestReportedMs: day('2026-11-06'), lastOkMs: now - 13 * H });
  check('health: no successful fetch in 13 h → collector stale, checked before upstream',
    collector.state === 'stale' && collector.reason === 'collector');
  check('health: unknown last success (Redis reset) → judged on the data alone',
    crimeHealth({ ...base, newestReportedMs: day('2026-11-06'), lastOkMs: null }).state === 'fresh');
  const lined = withHealthLine('Lead line.\n- item one', upstream);
  check('health: the line goes right after the lead', lined.split('\n')[1] === (upstream.state === 'stale' ? upstream.text : ''));
  check('health: fresh data leaves the body alone', withHealthLine('Lead.\n- x', { state: 'fresh' }) === 'Lead.\n- x');
}

// ── cost ledger: new models price as themselves ───────────────────────────
check('price: claude-sonnet-5-5 is not priced as claude-sonnet-5', priceOf('claude-sonnet-5-5').in === 2 && priceOf('claude-sonnet-5').in === 3);
check('price: claude-haiku-5-5', priceOf('claude-haiku-5-5').out === 0.5);

// ── optional: one real fetch, no database ────────────────────────────────
async function live(): Promise<void> {
  const { fetchOffenses } = await import('../src/home/crime.js');
  const since = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const t0 = Date.now();
  const rows = await fetchOffenses(PUBLIC, since);
  const within = rows.filter((r) => distMi(PUBLIC.lat, PUBLIC.lon, r.lat, r.lon) <= WALK_RADIUS_MI);
  const ids = new Set(rows.map((r) => r.id));
  const flagged = within.filter((r) => nearbyRule(r, distMi(PUBLIC.lat, PUBLIC.lon, r.lat, r.lon)));
  check('live: Denver answered with offenses in the box', rows.length > 0, `${rows.length} rows in ${Date.now() - t0} ms`);
  check('live: OFFENSE_ID is unique per row', ids.size === rows.length);
  check('live: every row parsed a category and a reported time',
    rows.every((r) => r.category && Number.isFinite(r.reportedMs)));
  console.log(`      ${within.length} within 1 mi of the public anchor since ${since}; ${flagged.length} would be note items`);
}

(process.argv.includes('--live') ? live() : Promise.resolve())
  .catch((e) => {
    check('live fetch', false, String(e));
  })
  .finally(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll home checks passed.');
  });
