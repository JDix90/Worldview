/**
 * Lunar ephemeris checks against well-anchored syzygies and physical bounds.
 * Run: pnpm --filter @orrery/web verify:lunar
 */
import { sublunarPoint } from '../src/globe/lunar.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// J2000-era syzygy anchors (astronomical almanac):
const newMoon = sublunarPoint(new Date('2000-01-06T18:14:00Z'));
check('2000-01-06 new moon → illumination ≈ 0', newMoon.illumination < 0.02, `k=${newMoon.illumination.toFixed(4)}`);

const fullMoon = sublunarPoint(new Date('2000-01-21T04:40:00Z'));
check('2000-01-21 full moon → illumination ≈ 1', fullMoon.illumination > 0.98, `k=${fullMoon.illumination.toFixed(4)}`);

// physical envelope over one anomalistic month, sampled every 6h
let minDist = Infinity, maxDist = 0, maxAbsLat = 0;
for (let h = 0; h < 28 * 24; h += 6) {
  const p = sublunarPoint(new Date(Date.parse('2026-07-01T00:00:00Z') + h * 3600_000));
  minDist = Math.min(minDist, p.distanceKm);
  maxDist = Math.max(maxDist, p.distanceKm);
  maxAbsLat = Math.max(maxAbsLat, Math.abs(p.lat));
  if (p.lng < -180 || p.lng > 180) failures++, console.log(`FAIL  lng out of range at +${h}h: ${p.lng}`);
}
check('perigee/apogee inside physical range (356–407 Mm)', minDist > 350_000 && maxDist < 410_000,
  `${Math.round(minDist)}–${Math.round(maxDist)} km`);
check('sublunar latitude bounded by max declination (≤29°)', maxAbsLat <= 29, `max |lat| = ${maxAbsLat.toFixed(1)}°`);

// sublunar point circles the globe ~once/day: in 12h earth rotates 180° while
// the moon's orbit claws back ~6.6°, so the wrapped longitude change should be
// ≈ 173° — i.e. within ~15° of a half turn
const a = sublunarPoint(new Date('2026-07-16T00:00:00Z'));
const b = sublunarPoint(new Date('2026-07-16T12:00:00Z'));
const wrapped = Math.abs(((b.lng - a.lng + 540) % 360) - 180);
const deviation = 180 - wrapped;
check('sublunar point sweeps ≈173° in 12h (earth rotation − lunar orbit)', deviation > 2 && deviation < 15,
  `swept ${wrapped.toFixed(1)}°, deviation ${deviation.toFixed(1)}°`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll lunar checks passed.');
