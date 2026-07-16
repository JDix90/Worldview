/**
 * Pure detector checks — no Redis, no Postgres. D0 conditions, D2 squawk
 * rules (persistence, clustering, expiry), and the S1 cap decision.
 * Run: pnpm --filter @orrery/worker verify:detectors
 */
import { detectDataHealth } from '../src/detect/d0DataHealth.js';
import { detectSquawks, haversineKm, type D2State } from '../src/detect/d2Squawks.js';
import { decideSeverity } from '../src/detect/emit.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── D0 ────────────────────────────────────────────────────────────────
const NOW = 1_800_000_000;
const history = Array.from({ length: 12 }, (_, i) => ({ ts: NOW - 3600 + i * 300, total: 10_000 }));

const healthy = detectDataHealth({ nowS: NOW, snapshotFetchedAt: NOW - 90, totalAirborne: 9_800, recentTotals: history });
check('D0 healthy → coverage ok, no conditions', healthy.coverageOk && healthy.conditions.length === 0);

const stale = detectDataHealth({ nowS: NOW, snapshotFetchedAt: NOW - 600, totalAirborne: 9_800, recentTotals: history });
check('D0 stale snapshot → condition, coverage not ok',
  !stale.coverageOk && stale.conditions.some((c) => c.kind === 'snapshot_stale'));

const drop = detectDataHealth({ nowS: NOW, snapshotFetchedAt: NOW - 90, totalAirborne: 5_500, recentTotals: history });
check('D0 45% global drop → condition', !drop.coverageOk && drop.conditions.some((c) => c.kind === 'global_count_drop'),
  `delta=${drop.globalDeltaPct.toFixed(1)}%`);

const mild = detectDataHealth({ nowS: NOW, snapshotFetchedAt: NOW - 90, totalAirborne: 8_000, recentTotals: history });
check('D0 20% dip → no false alarm', mild.coverageOk, `delta=${mild.globalDeltaPct.toFixed(1)}%`);

const thin = detectDataHealth({ nowS: NOW, snapshotFetchedAt: NOW - 90, totalAirborne: 5_500, recentTotals: history.slice(0, 3) });
check('D0 refuses drop verdict on 3 buckets of history', thin.coverageOk);

// ── D2 ────────────────────────────────────────────────────────────────
const empty: D2State = { entries: {} };
const hijack = { hex: 'abc123', lat: 50, lon: 10, callsign: 'TST001', seenAt: NOW };

const c1 = detectSquawks(NOW, { '7500': [hijack], '7600': [], '7700': [] }, empty);
check('D2 7500 first cycle → no S1 yet', c1.events.length === 0);
const c2 = detectSquawks(NOW + 60, { '7500': [{ ...hijack, seenAt: NOW + 60 }], '7600': [], '7700': [] }, c1.state);
check('D2 7500 second consecutive cycle → S1', c2.events.some((e) => e.kind === 'squawk_7500' && e.severity === 'S1'));

const gap = detectSquawks(NOW + 600, { '7500': [{ ...hijack, seenAt: NOW + 600 }], '7600': [], '7700': [] }, c1.state);
check('D2 10-min gap breaks persistence → no S1', gap.events.length === 0);

// regression (found live 2026-07-16): detect cycles outpace the snapshot —
// the SAME observation seen by two cycles must not count as persistence
const sameObs = detectSquawks(NOW + 60, { '7500': [hijack], '7600': [], '7700': [] }, c1.state);
check('D2 same observation across two cycles → still no S1', sameObs.events.length === 0);
const thenNew = detectSquawks(NOW + 120, { '7500': [{ ...hijack, seenAt: NOW + 100 }], '7600': [], '7700': [] }, sameObs.state);
check('D2 then a genuinely new observation → S1', thenNew.events.some((e) => e.kind === 'squawk_7500'));

// regression: ramp transponder tests must be invisible to D2
const ground = detectSquawks(NOW, { '7500': [{ ...hijack, onGround: true }], '7600': [], '7700': [] }, empty);
check('D2 on-ground 7500 ignored entirely', ground.events.length === 0 && Object.keys(ground.state.entries).length === 0);

const radio = detectSquawks(NOW, { '7500': [], '7600': [hijack], '7700': [] }, empty);
check('D2 7600 first sight → S3', radio.events.some((e) => e.kind === 'squawk_7600' && e.severity === 'S3'));

const near = [
  { hex: 'aaa001', lat: 50, lon: 10, seenAt: NOW },
  { hex: 'bbb002', lat: 51, lon: 12, seenAt: NOW }, // ~180 km away
];
const cluster = detectSquawks(NOW, { '7500': [], '7600': [], '7700': near }, empty);
check('D2 two 7700 within 500km → S2 cluster + two S3s',
  cluster.events.filter((e) => e.severity === 'S3').length === 2 &&
  cluster.events.some((e) => e.kind === 'squawk_7700_cluster' && e.severity === 'S2'));

const far = [
  { hex: 'aaa001', lat: 50, lon: 10, seenAt: NOW },
  { hex: 'bbb002', lat: 30, lon: 60, seenAt: NOW },
];
const noCluster = detectSquawks(NOW, { '7500': [], '7600': [], '7700': far }, empty);
check('D2 two distant 7700 → no cluster', !noCluster.events.some((e) => e.kind === 'squawk_7700_cluster'));

const expired = detectSquawks(NOW + 2000, { '7500': [], '7600': [], '7700': [] }, cluster.state);
check('D2 entries expire after 30 min', Object.keys(expired.state.entries).length === 0);

check('haversine sanity (London→Paris ≈ 344 km)',
  Math.abs(haversineKm(51.47, -0.45, 49.01, 2.55) - 344) < 15,
  `${haversineKm(51.47, -0.45, 49.01, 2.55).toFixed(0)} km`);

// ── S1 cap ────────────────────────────────────────────────────────────
const nowMs = NOW * 1000;
check('cap: under limit stays S1', decideSeverity('S1', [nowMs - 1000], nowMs).severity === 'S1');
const capped = decideSeverity('S1', [nowMs - 1000, nowMs - 2000, nowMs - 3000], nowMs);
check('cap: 3 in window → demote with audit', capped.severity === 'S2' && capped.demoted_from === 'S1');
const aged = decideSeverity('S1', [nowMs - 25 * 3600_000, nowMs - 26 * 3600_000, nowMs - 27 * 3600_000], nowMs);
check('cap: S1s older than 24h do not count', aged.severity === 'S1');
check('cap: S2/S3 pass through untouched', decideSeverity('S3', [nowMs, nowMs, nowMs], nowMs).severity === 'S3');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll detector checks passed.');
