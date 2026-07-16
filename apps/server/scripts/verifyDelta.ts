/**
 * Pure checks on snapshot diffing. Run: pnpm --filter @orrery/server verify:delta
 */
import type { AircraftState } from '@orrery/shared';
import { computeDelta } from '../src/delta.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function ac(hex: string, over: Partial<AircraftState> = {}): AircraftState {
  return {
    hex,
    lat: 50,
    lon: 10,
    onGround: false,
    seenAt: 1000,
    source: 'opensky',
    groundSpeedMs: 200,
    trackDeg: 90,
    ...over,
  };
}

const prev = new Map<string, AircraftState>([
  ['aaa111', ac('aaa111')],
  ['bbb222', ac('bbb222')],
  ['ccc333', ac('ccc333')],
]);

// moved aircraft → upsert; vanished → remove; new → upsert; untouched → neither
const next = [
  ac('aaa111', { lat: 50.2, seenAt: 1090 }), // moved
  ac('bbb222'),                              // byte-identical state
  ac('ddd444', { seenAt: 1090 }),            // new
];
const d = computeDelta(prev, next);
check('moved + new aircraft upserted', d.upsert.length === 2 &&
  d.upsert.some(a => a.hex === 'aaa111') && d.upsert.some(a => a.hex === 'ddd444'),
  `upsert=${d.upsert.map(a => a.hex).join(',')}`);
check('unchanged aircraft not re-sent', !d.upsert.some(a => a.hex === 'bbb222'));
check('vanished aircraft removed', d.remove.length === 1 && d.remove[0] === 'ccc333');

// squawk-only change (no movement) must still propagate — emergencies matter
const d2 = computeDelta(new Map([['aaa111', ac('aaa111')]]), [ac('aaa111', { squawk: '7700' })]);
check('squawk change alone is an upsert', d2.upsert.length === 1);

// empty next removes everything, empty prev upserts everything
const d3 = computeDelta(prev, []);
check('empty snapshot removes all', d3.remove.length === 3 && d3.upsert.length === 0);
const d4 = computeDelta(new Map(), next);
check('cold start upserts all', d4.upsert.length === 3 && d4.remove.length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll delta checks passed.');
