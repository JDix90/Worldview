/**
 * Global surface ocean-current field from Open-Meteo's Marine API (CORS-open
 * JSON, same family as the wind layer's source). Two conventions verified
 * live 2026-07-17 (DECISIONS #74):
 *  - velocity is km/h (wind was m/s) — converted on ingest;
 *  - direction is flowing-TOWARD (oceanographic convention, OPPOSITE of
 *    wind's blowing-FROM): Cape Hatteras read 42° at 6.5 km/h — the Gulf
 *    Stream flowing northeast. So u/v take NO negation here.
 * Land points return null → stored as 0, which the particle layer treats as
 * "dead water" and respawns out of.
 *
 * 10° grid in ONE request — the wind layer's proven shape. A 5° chunked
 * grid was tried first and 429'd even at 1.2s chunk spacing (the Marine API
 * shares the forecast API's burst sensitivity; multi-chunk bursts are the
 * problem, not quota). Coarse but honest: gyres and the major boundary
 * currents still read; their cores are just wider than life.
 */

export const LAT_MIN = -75;
export const LON_MIN = -180;
export const STEP = 10;
export const NLAT = (75 - LAT_MIN) / STEP + 1; // 16 rows
export const NLON = 360 / STEP; // 36 cols

export interface OceanField {
  u: Float32Array; // eastward m/s
  v: Float32Array; // northward m/s
  fetchedAt: number;
}

const API = 'https://marine-api.open-meteo.com/v1/marine';
const CHUNK = 700; // the 576-point 10° grid fits in one request
const CHUNK_GAP_MS = 1200; // only used if the grid ever exceeds CHUNK
const CACHE_KEY = 'orrery:ocean';
const CACHE_TTL_MS = 6 * 3600_000;
const KMH_TO_MS = 1 / 3.6;
const DEG = Math.PI / 180;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readCache(): OceanField | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { u: number[]; v: number[]; fetchedAt: number };
    return { u: Float32Array.from(c.u), v: Float32Array.from(c.v), fetchedAt: c.fetchedAt };
  } catch {
    return null;
  }
}

function writeCache(f: OceanField): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        u: Array.from(f.u, (x) => Math.round(x * 1000) / 1000),
        v: Array.from(f.v, (x) => Math.round(x * 1000) / 1000),
        fetchedAt: f.fetchedAt,
      }),
    );
  } catch {
    /* quota — memory copy still serves this session */
  }
}

function gridCoords(): { lat: number[]; lon: number[] } {
  const lat: number[] = [];
  const lon: number[] = [];
  for (let r = 0; r < NLAT; r++) {
    for (let c = 0; c < NLON; c++) {
      lat.push(LAT_MIN + r * STEP);
      lon.push(LON_MIN + c * STEP);
    }
  }
  return { lat, lon };
}

interface MarineCurrent {
  current?: { ocean_current_velocity?: number | null; ocean_current_direction?: number | null };
}

async function fetchChunk(
  lat: number[], lon: number[], start: number, end: number, u: Float32Array, v: Float32Array,
): Promise<void> {
  const q = new URLSearchParams({
    latitude: lat.slice(start, end).join(','),
    longitude: lon.slice(start, end).join(','),
    current: 'ocean_current_velocity,ocean_current_direction',
  });
  const res = await fetch(`${API}?${q.toString()}`);
  if (!res.ok) throw new Error(`Marine API HTTP ${res.status}`);
  const body = (await res.json()) as MarineCurrent[] | MarineCurrent;
  const arr = Array.isArray(body) ? body : [body];
  for (let k = 0; k < arr.length; k++) {
    const cur = arr[k]?.current;
    const speed = (cur?.ocean_current_velocity ?? 0) * KMH_TO_MS; // null (land) → 0
    const dir = cur?.ocean_current_direction ?? 0;
    // flowing-TOWARD convention: no negation (contrast windField.ts)
    u[start + k] = speed * Math.sin(dir * DEG);
    v[start + k] = speed * Math.cos(dir * DEG);
  }
}

export async function fetchOceanField(): Promise<OceanField> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const { lat, lon } = gridCoords();
  const n = lat.length;
  const u = new Float32Array(n);
  const v = new Float32Array(n);

  try {
    for (let start = 0; start < n; start += CHUNK) {
      if (start > 0) await sleep(CHUNK_GAP_MS);
      await fetchChunk(lat, lon, start, Math.min(start + CHUNK, n), u, v);
    }
  } catch (err) {
    if (cached) {
      console.warn('[ocean] fetch failed, using stale cache', err);
      return cached;
    }
    throw err;
  }

  const field: OceanField = { u, v, fetchedAt: Date.now() };
  writeCache(field);
  return field;
}

/** Bilinear sample; lon wraps, lat clamps. Writes [u,v] into out; returns speed. */
export function sampleUV(field: OceanField, lat: number, lon: number, out: [number, number]): number {
  const fr = (lat - LAT_MIN) / STEP;
  const fc = ((((lon - LON_MIN) % 360) + 360) % 360) / STEP;
  const r0 = Math.floor(fr);
  const c0 = Math.floor(fc);
  if (r0 < 0 || r0 >= NLAT - 1) {
    out[0] = 0;
    out[1] = 0;
    return 0;
  }
  const tr = fr - r0;
  const tc = fc - c0;
  const c1 = (c0 + 1) % NLON;
  const i00 = r0 * NLON + c0, i01 = r0 * NLON + c1;
  const i10 = (r0 + 1) * NLON + c0, i11 = (r0 + 1) * NLON + c1;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const u = lerp(lerp(field.u[i00]!, field.u[i01]!, tc), lerp(field.u[i10]!, field.u[i11]!, tc), tr);
  const v = lerp(lerp(field.v[i00]!, field.v[i01]!, tc), lerp(field.v[i10]!, field.v[i11]!, tc), tr);
  out[0] = u;
  out[1] = v;
  return Math.hypot(u, v);
}
