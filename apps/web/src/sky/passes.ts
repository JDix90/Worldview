/**
 * ISS visible-pass prediction for the home location — the "step outside and
 * look up" feature. Reuses the stations TLEs the satellites layer already
 * caches (12 h IndexedDB TTL, CelesTrak etiquette) and satellite.js (vendored,
 * v5). A pass is *visible* when the satellite is above 10° elevation, sunlit,
 * and the observer is in twilight/darkness (sun below −6°).
 */
import * as satellite from 'satellite.js';
import { fetchTles } from '../layers/satellites/tleSource';
import { subsolarPoint } from '../globe/solar';

export interface Pass {
  riseMs: number;
  riseDir: string; // compass at rise
  maxElDeg: number;
  durationS: number;
  bright: boolean; // max elevation ≥ 40° reads as a bright, easy pass
}

const DEG = Math.PI / 180;

function compass16(deg: number): string {
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(deg / 22.5) % 16]!;
}

/** Sun elevation at observer, degrees (from the subsolar point — same solar
 * math the terminator uses, so the whole app agrees on where the sun is). */
function sunElevation(lat: number, lon: number, date: Date): number {
  const sp = subsolarPoint(date);
  const cosZ =
    Math.sin(lat * DEG) * Math.sin(sp.lat * DEG) +
    Math.cos(lat * DEG) * Math.cos(sp.lat * DEG) * Math.cos((lon - sp.lng) * DEG);
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZ))) / DEG;
}

/** Is the satellite itself in sunlight? Cylindrical-shadow approximation. */
function satSunlit(eciKm: { x: number; y: number; z: number }, date: Date): boolean {
  const sp = subsolarPoint(date);
  const gmst = satellite.gstime(date);
  // sun unit vector in ECI ≈ ECF sun direction rotated by gmst
  const lonEci = sp.lng * DEG + gmst;
  const sun = {
    x: Math.cos(sp.lat * DEG) * Math.cos(lonEci),
    y: Math.cos(sp.lat * DEG) * Math.sin(lonEci),
    z: Math.sin(sp.lat * DEG),
  };
  const dot = eciKm.x * sun.x + eciKm.y * sun.y + eciKm.z * sun.z;
  if (dot > 0) return true; // sat on the day side
  // component of position perpendicular to the sun line vs Earth's radius
  const perp2 =
    eciKm.x ** 2 + eciKm.y ** 2 + eciKm.z ** 2 - dot ** 2;
  return Math.sqrt(Math.max(0, perp2)) > 6371;
}

/** Next visible ISS passes over (lat, lon) within the coming `hours`. */
export async function nextIssPasses(lat: number, lon: number, hours = 24): Promise<Pass[]> {
  const tles = await fetchTles(['stations']);
  const iss = tles.find((t) => /ISS|ZARYA/i.test(t.name));
  if (!iss) return [];
  const satrec = satellite.twoline2satrec(iss.l1, iss.l2);
  const observer = {
    latitude: lat * DEG,
    longitude: lon * DEG,
    height: 1.6, // km — Denver-ish; elevation errors are negligible at pass scale
  };

  const passes: Pass[] = [];
  const stepMs = 30_000;
  const start = Date.now();
  let inPass = false;
  let rise = 0, riseAz = 0, maxEl = -90, visibleSamples = 0, samples = 0;

  for (let t = start; t < start + hours * 3600_000; t += stepMs) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position || typeof pv.position === 'boolean') continue;
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observer, ecf);
    const el = look.elevation / DEG;

    if (el > 10) {
      if (!inPass) {
        inPass = true;
        rise = t;
        riseAz = look.azimuth / DEG;
        maxEl = el;
        visibleSamples = 0;
        samples = 0;
      }
      maxEl = Math.max(maxEl, el);
      samples++;
      if (satSunlit(pv.position, date) && sunElevation(lat, lon, date) < -6) visibleSamples++;
    } else if (inPass) {
      inPass = false;
      // visible if the sky-geometry conditions held for most of the pass
      if (samples > 0 && visibleSamples / samples > 0.4) {
        passes.push({
          riseMs: rise,
          riseDir: compass16(((riseAz % 360) + 360) % 360),
          maxElDeg: Math.round(maxEl),
          durationS: Math.round((t - rise) / 1000),
          bright: maxEl >= 40,
        });
      }
    }
  }
  return passes;
}
