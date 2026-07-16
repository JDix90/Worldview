/**
 * Checks subsolarPoint() against reference ephemeris values (NOAA solar
 * calculator / Astronomical Almanac). Run: pnpm --filter @orrery/web verify:solar
 * Exits non-zero on any miss — the terminator gate is ±1°, checks are tighter.
 */
import { subsolarPoint } from '../src/globe/solar.js';

let failures = 0;

function check(name: string, actual: number, expected: number, tol: number, unit: string) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual.toFixed(3)}${unit}, expected ${expected}±${tol}${unit}`,
  );
}

// June solstice: declination at maximum.
const jun = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
check('Jun 21 declination', jun.lat, 23.43, 0.1, '°');

// December solstice: minimum.
const dec = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
check('Dec 21 declination', dec.lat, -23.43, 0.1, '°');

// March equinox 2026 (~14:46 UTC): declination crosses zero.
const equinox = subsolarPoint(new Date('2026-03-20T15:00:00Z'));
check('Mar 20 equinox declination', equinox.lat, 0.0, 0.2, '°');

// Mid-July: declination and equation of time.
const jul = subsolarPoint(new Date('2026-07-14T12:00:00Z'));
check('Jul 14 declination', jul.lat, 21.65, 0.3, '°');
check('Jul 14 equation of time', jul.equationOfTimeMin, -5.9, 0.8, ' min');

// Equation-of-time extremes.
const nov = subsolarPoint(new Date('2026-11-03T12:00:00Z'));
check('Nov 3 equation of time', nov.equationOfTimeMin, 16.45, 0.7, ' min');
const feb = subsolarPoint(new Date('2026-02-11T12:00:00Z'));
check('Feb 11 equation of time', feb.equationOfTimeMin, -14.2, 0.7, ' min');

// Subsolar longitude consistency: at 12:00 UTC it must equal -EoT/4 degrees;
// six hours later it must sit 90° further west.
check('Jul 14 12:00Z subsolar lng', jul.lng, -jul.equationOfTimeMin / 4, 0.01, '°');
const jul18 = subsolarPoint(new Date('2026-07-14T18:00:00Z'));
check('Jul 14 18:00Z subsolar lng', jul18.lng, jul.lng - 90, 0.05, '°');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll solar checks passed.');
