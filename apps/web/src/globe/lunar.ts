/**
 * Sublunar point + phase — truncated Meeus lunar theory (principal terms
 * only, ~0.3° typical error; plenty for a marker on a 100-unit globe).
 * Verified against J2000-era syzygy anchors by `pnpm --filter @orrery/web
 * verify:lunar`.
 */

const DEG = Math.PI / 180;

export interface SublunarPoint {
  lat: number;
  /** Degrees east, normalized to [-180, 180]. */
  lng: number;
  distanceKm: number;
  /** Illuminated fraction 0..1. */
  illumination: number;
  /** True while illumination is increasing night-over-night. */
  waxing: boolean;
  phaseName: string;
}

function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

export function sublunarPoint(date: Date): SublunarPoint {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;

  // fundamental arguments (degrees)
  const Lp = norm360(218.3164477 + 481267.88123421 * T); // moon mean longitude
  const D = norm360(297.8501921 + 445267.1114034 * T);   // mean elongation
  const M = norm360(357.5291092 + 35999.0502909 * T);    // sun mean anomaly
  const Mp = norm360(134.9633964 + 477198.8675055 * T);  // moon mean anomaly
  const F = norm360(93.272095 + 483202.0175233 * T);     // argument of latitude

  const sin = (x: number) => Math.sin(x * DEG);
  const cos = (x: number) => Math.cos(x * DEG);

  // ecliptic longitude/latitude (principal Meeus terms)
  const lambda =
    Lp +
    6.288774 * sin(Mp) +
    1.274027 * sin(2 * D - Mp) +
    0.658314 * sin(2 * D) +
    0.213618 * sin(2 * Mp) -
    0.185116 * sin(M) -
    0.114332 * sin(2 * F);
  const beta =
    5.128122 * sin(F) + 0.280602 * sin(Mp + F) + 0.277693 * sin(Mp - F);
  const distanceKm =
    385000.56 - 20905.355 * cos(Mp) - 3699.111 * cos(2 * D - Mp) - 2955.968 * cos(2 * D);

  // ecliptic → equatorial
  const eps = 23.4393 - 0.013 * T;
  const sinDec = sin(beta) * cos(eps) + cos(beta) * sin(eps) * sin(lambda);
  const dec = Math.asin(Math.min(Math.max(sinDec, -1), 1)) / DEG;
  const ra = Math.atan2(sin(lambda) * cos(eps) - Math.tan(beta * DEG) * sin(eps), cos(lambda)) / DEG;

  // equatorial → sublunar geodetic via Greenwich sidereal time
  const gmst = norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0));
  const lng = ((norm360(ra) - gmst + 540) % 360) - 180;

  // illumination from geocentric elongation vs the sun's apparent longitude
  // (same low-precision solar theory as solar.ts)
  const sunL0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const sunC =
    (1.914602 - T * (0.004817 + 0.000014 * T)) * sin(M) +
    (0.019993 - 0.000101 * T) * sin(2 * M) +
    0.000289 * sin(3 * M);
  const sunLambda = sunL0 + sunC;
  const cosE = cos(beta) * cos(lambda - sunLambda);
  const illumination = (1 - cosE) / 2;
  const waxing = sin(lambda - sunLambda) > 0;

  const phaseName =
    illumination < 0.03 ? 'new moon'
    : illumination > 0.97 ? 'full moon'
    : illumination < 0.47 ? (waxing ? 'waxing crescent' : 'waning crescent')
    : illumination > 0.53 ? (waxing ? 'waxing gibbous' : 'waning gibbous')
    : waxing ? 'first quarter' : 'last quarter';

  return { lat: dec, lng, distanceKm, illumination, waxing, phaseName };
}
