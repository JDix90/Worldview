/**
 * Chunk 5 replay harness (PHASES.md DoD): runs the pure detectors against
 * RECORDED raw poll data from data/raw/ with injected anomalies. No Redis, no
 * Postgres, no network — this is exactly what the raw store exists for.
 *
 * Scenarios:
 *  1. control            — real snapshot vs baselines built from itself → silence
 *  2. regional collapse  — busiest cell loses 65% → D1 S2, then S1 as it persists
 *  3. coverage drop      — ALL cells lose 45% → D0 flags it and D1 stays silent
 *  4. squawk persistence — same observation twice ≠ persistence; advancing = S1
 *  5. GPS interference   — real Baltic sweep with 60% low-NIC injected → D3 S2
 *  6. S1 cap             — 4th S1 in 24h demotes with demoted_from
 *
 * Run: pnpm --filter @orrery/worker verify:replay
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cellIdFor } from '@orrery/shared';
import { detectDataHealth } from '../src/detect/d0DataHealth.js';
import { detectCollapse, type CellBaseline, type D1State } from '../src/detect/d1Collapse.js';
import { detectSquawks, type D2State } from '../src/detect/d2Squawks.js';
import { detectGpsInterference, type D3State, type RegionSample } from '../src/detect/d3Gps.js';
import { decideSeverity } from '../src/detect/emit.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function newestRaw(dir: string, match: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.includes(match)).sort();
  return files.length ? path.join(dir, files[files.length - 1]!) : null;
}

const RAW_ROOT = path.resolve(process.cwd(), fs.existsSync('data/raw') ? 'data/raw' : '../../data/raw');

// ── load a recorded OpenSky snapshot ──────────────────────────────────
// raw /states/all shape: {time, states: [[icao24, callsign, country, t_pos,
// t_contact, lon, lat, baro_alt, on_ground, ...], ...]} — same index map as
// sources/opensky.ts (duplicated here deliberately: the harness must not
// depend on network-bound modules).
const statesFile = newestRaw(path.join(RAW_ROOT, 'opensky'), '-states');
if (!statesFile) {
  console.error(`No recorded OpenSky raw files under ${RAW_ROOT}/opensky — run the collector first.`);
  process.exit(1);
}
const rawStates = JSON.parse(gunzipSync(fs.readFileSync(statesFile)).toString()) as {
  time: number;
  states: Array<Array<unknown>> | null;
};
const cellCounts: Record<string, number> = {};
let airborneTotal = 0;
for (const s of rawStates.states ?? []) {
  const lon = s[5], lat = s[6], onGround = s[8];
  if (typeof lat !== 'number' || typeof lon !== 'number' || onGround === true) continue;
  airborneTotal++;
  const cell = cellIdFor(lat, lon);
  cellCounts[cell] = (cellCounts[cell] ?? 0) + 1;
}
console.log(`replaying ${path.basename(statesFile)} — ${airborneTotal} airborne aircraft, ${Object.keys(cellCounts).length} cells\n`);

// synthetic baselines derived from the recorded snapshot itself: each busy
// cell's median IS its current count, so the unmodified snapshot must be quiet
const baselines: Record<string, CellBaseline> = {};
for (const [cell, count] of Object.entries(cellCounts)) {
  if (count >= 20) {
    baselines[cell] = { median: count, mad: Math.max(1, Math.round(count * 0.1)), days: 16, daytype: 'weekday' };
  }
}
const T0 = rawStates.time;
const run = (counts: Record<string, number>, fetchedAt: number, nowS: number, coverageOk: boolean, state: D1State) =>
  detectCollapse({ nowS, snapshotFetchedAt: fetchedAt, cellCounts: counts, baselines, coverageOk }, state);

// ── 1. control: unmodified snapshot stays silent across two observations ──
let s1 = run(cellCounts, T0, T0, true, { entries: {} });
s1 = run(cellCounts, T0 + 90, T0 + 90, true, s1.state);
check('control: real snapshot vs own baselines → no D1 events', s1.events.length === 0);

// ── 2. injected regional collapse ─────────────────────────────────────
const hotCell = Object.entries(cellCounts).sort((a, b) => b[1] - a[1])[0]![0];
const hotCount = cellCounts[hotCell]!;
const collapsed = { ...cellCounts, [hotCell]: Math.round(hotCount * 0.35) };
let c = run(collapsed, T0, T0, true, { entries: {} });
check('collapse: first observation → tracked, no event yet', c.events.length === 0);
c = run(collapsed, T0 + 90, T0 + 60, true, c.state);
check('collapse: 2nd independent observation → S2 fires',
  c.events.some((e) => e.cell === hotCell && e.severity === 'S2'),
  `cell=${hotCell} ${hotCount}→${collapsed[hotCell]}`);
c = run(collapsed, T0 + 180, T0 + 120, true, c.state);
check('collapse: 3rd observation at 65% drop → escalates to S1',
  c.events.some((e) => e.cell === hotCell && e.severity === 'S1'));
const sameObs = run(collapsed, T0 + 180, T0 + 175, true, c.state);
check('collapse: re-reading the SAME snapshot adds no persistence',
  (sameObs.state.entries[hotCell]?.breaches ?? 0) === (c.state.entries[hotCell]?.breaches ?? -1));

// ── 3. injected coverage drop: D0 fires, D1 must stay silent ──────────
const scaled: Record<string, number> = {};
for (const [cell, n] of Object.entries(cellCounts)) scaled[cell] = Math.round(n * 0.55);
const d0 = detectDataHealth({
  nowS: T0,
  snapshotFetchedAt: T0,
  totalAirborne: Math.round(airborneTotal * 0.55),
  recentTotals: Array.from({ length: 12 }, (_, i) => ({ ts: T0 - 3600 + i * 300, total: airborneTotal })),
});
check('coverage drop: D0 flags global_count_drop, coverage_ok=false',
  !d0.coverageOk && d0.conditions.some((x) => x.kind === 'global_count_drop'));
let g = run(scaled, T0, T0, d0.coverageOk, { entries: {} });
g = run(scaled, T0 + 90, T0 + 60, d0.coverageOk, g.state);
g = run(scaled, T0 + 180, T0 + 120, d0.coverageOk, g.state);
check('coverage drop: D1 suppressed — zero events despite 45% cell drops', g.events.length === 0);

// ── 4. squawk persistence against a real aircraft ─────────────────────
const anyAirborne = (rawStates.states ?? []).find((s) => s[8] === false && typeof s[6] === 'number')!;
const hijack = {
  hex: String(anyAirborne[0]), lat: anyAirborne[6] as number, lon: anyAirborne[5] as number,
  seenAt: T0, srcOpenSky: true, srcAdsbfi: true, // corroborated by both networks
};
let q = detectSquawks(T0, { '7500': [hijack], '7600': [], '7700': [] }, { entries: {} } as D2State);
q = detectSquawks(T0 + 60, { '7500': [hijack], '7600': [], '7700': [] }, q.state);
check('squawk: same observation seen by two cycles → nothing', q.events.length === 0);
q = detectSquawks(T0 + 120, { '7500': [{ ...hijack, seenAt: T0 + 100 }], '7600': [], '7700': [] }, q.state);
check('squawk: 2nd independent observation → S2 tier (below corroborated-S1 bar)',
  q.events.some((e) => e.kind === 'squawk_7500' && e.severity === 'S2'));
q = detectSquawks(T0 + 240, { '7500': [{ ...hijack, seenAt: T0 + 220 }], '7600': [], '7700': [] }, q.state);
check('squawk: corroborated, 3 obs over 3+ min → S1 fires (DECISIONS #52)',
  q.events.some((e) => e.kind === 'squawk_7500' && e.severity === 'S1'));
// same persistence but single-network: the aggregator-cache failure mode → S2 only
const solo = { ...hijack, srcOpenSky: false, srcAdsbfi: true };
let sq = detectSquawks(T0, { '7500': [solo], '7600': [], '7700': [] }, { entries: {} } as D2State);
sq = detectSquawks(T0 + 120, { '7500': [{ ...solo, seenAt: T0 + 110 }], '7600': [], '7700': [] }, sq.state);
sq = detectSquawks(T0 + 240, { '7500': [{ ...solo, seenAt: T0 + 220 }], '7600': [], '7700': [] }, sq.state);
check('squawk: single-network cache artifact, same persistence → never S1',
  !sq.events.some((e) => e.severity === 'S1'));

// ── 5. GPS interference from a recorded Baltic sweep ──────────────────
const balticFile = newestRaw(path.join(RAW_ROOT, 'adsbfi'), 'integrity-baltic');
let balticAircraft = 60; // fallback if no sweep is recorded yet
if (balticFile) {
  const sweeps = JSON.parse(gunzipSync(fs.readFileSync(balticFile)).toString()) as Array<{ ac?: Array<{ nic?: number }> }>;
  const withNic = sweeps.flatMap((s) => s.ac ?? []).filter((a) => typeof a.nic === 'number');
  if (withNic.length >= 20) balticAircraft = withNic.length;
  console.log(`\nreplaying ${path.basename(balticFile)} — ${balticAircraft} aircraft with NIC data`);
} else {
  console.log('\n(no recorded baltic sweep — using synthetic fleet of 60)');
}
const mkSample = (fetchedAt: number, fraction: number): RegionSample => ({
  regionId: 'baltic', name: 'Baltic / Kaliningrad corridor', fetchedAt,
  aircraft: balticAircraft, lowNic: Math.round(balticAircraft * fraction),
});
const history = { baltic: { medianFraction: 0.14, days: 12 } };
let d3 = detectGpsInterference({ nowS: T0, samples: [mkSample(T0, 0.6)], history }, { entries: {} } as D3State);
check('gps: first breaching sweep → tracked, no event', d3.events.length === 0);
d3 = detectGpsInterference({ nowS: T0 + 120, samples: [mkSample(T0 + 110, 0.62)], history }, d3.state);
check('gps: 2nd independent sweep at ~4× norm → S2 fires',
  d3.events.some((e) => e.kind === 'gps_interference' && e.severity === 'S2'));
const calm = detectGpsInterference({ nowS: T0, samples: [mkSample(T0, 0.14)], history }, { entries: {} } as D3State);
check('gps: fraction at the regional norm → silence', calm.events.length === 0);
const young = detectGpsInterference(
  { nowS: T0, samples: [mkSample(T0, 0.6)], history: { baltic: { medianFraction: 0.14, days: 2 } } },
  { entries: {} } as D3State,
);
check('gps: <3 days of history → detector stays quiet (warmup honesty)', young.events.length === 0);

// ── 6. S1 cap ─────────────────────────────────────────────────────────
const nowMs = T0 * 1000;
const three = [nowMs - 3600_000, nowMs - 7200_000, nowMs - 10_800_000];
const capped = decideSeverity('S1', three, nowMs);
check('cap: 4th S1 in 24h demotes to S2 with demoted_from',
  capped.severity === 'S2' && capped.demoted_from === 'S1');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll replay scenarios passed.');
