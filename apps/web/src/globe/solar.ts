/**
 * Subsolar point — where the sun is directly overhead right now. Drives the
 * day/night terminator shader. NOAA low-precision solar algorithm; accuracy
 * well inside the ±1° gate in PHASES.md chunk 1. Verified against reference
 * ephemeris values by `pnpm --filter @orrery/web verify:solar`.
 */

const DEG = Math.PI / 180;

export interface SubsolarPoint {
  /** Solar declination, degrees. */
  lat: number;
  /** Degrees east, normalized to [-180, 180]. */
  lng: number;
  equationOfTimeMin: number;
}

export function subsolarPoint(date: Date): SubsolarPoint {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;

  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const C =
    (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(M * DEG) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M * DEG) +
    0.000289 * Math.sin(3 * M * DEG);
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  const e0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = e0 + 0.00256 * Math.cos(omega * DEG);

  const declination = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) / DEG;

  const y = Math.tan((eps / 2) * DEG) ** 2;
  const eotRad =
    y * Math.sin(2 * L0 * DEG) -
    2 * e * Math.sin(M * DEG) +
    4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG) -
    0.5 * y * y * Math.sin(4 * L0 * DEG) -
    1.25 * e * e * Math.sin(2 * M * DEG);
  const equationOfTimeMin = (eotRad / DEG) * 4;

  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3600000;
  const lng = ((12 - utcHours - equationOfTimeMin / 60) * 15 + 540) % 360 - 180;

  return { lat: declination, lng, equationOfTimeMin };
}
