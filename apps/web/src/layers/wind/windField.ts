/**
 * Global 10m wind field from Open-Meteo (GFS-derived, CORS-open JSON — chosen
 * after the C0 spike: NOAA retired OPeNDAP, and GFS GRIB2 uses template 5.3
 * (complex packing + spatial differencing) which needs a WASM decoder we've
 * been bitten by. Open-Meteo is the same GFS data as clean JSON.
 *
 * 5° grid, -80..80 lat × -180..175 lon, fetched in URL-length-safe chunks.
 * u = eastward m/s, v = northward m/s (derived from speed + met direction).
 */

// 10° grid: 612 points fit in ONE Open-Meteo request. Its rate limit weights
// by location count, so a coarse single request (cached 6h) is far more
// sustainable than a fine multi-request grid — and bilinear-interpolated
// advection reads as smooth flow regardless of grid resolution.
export const LAT_MIN = -80;
export const LON_MIN = -180;
export const STEP = 10;
export const NLAT = (80 - LAT_MIN) / STEP + 1; // 17 rows
export const NLON = 360 / STEP; // 36 cols (-180..170)

export interface WindField {
  u: Float32Array; // [row * NLON + col], eastward m/s
  v: Float32Array; // northward m/s
  fetchedAt: number;
}

const CHUNK = 700; // the 612-point 10° grid fits in one request
const CHUNK_GAP_MS = 400; // spacing, only used if the grid ever exceeds CHUNK
const CACHE_KEY = 'orrery:wind';
const CACHE_TTL_MS = 6 * 3600_000;
const DEG = Math.PI / 180;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CachedField {
  u: number[];
  v: number[];
  fetchedAt: number;
}

function readCache(): WindField | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedField;
    return { u: Float32Array.from(c.u), v: Float32Array.from(c.v), fetchedAt: c.fetchedAt };
  } catch {
    return null;
  }
}

function writeCache(f: WindField): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ u: Array.from(f.u), v: Array.from(f.v), fetchedAt: f.fetchedAt }),
    );
  } catch {
    /* quota — memory copy still serves this session */
  }
}

/** Build the full ordered (lat, lon) coordinate list, row-major. */
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

export async function fetchWindField(): Promise<WindField> {
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
    // serve a stale field rather than an empty sky (matches TLE/launch layers)
    if (cached) {
      console.warn('[wind] fetch failed, using stale cache', err);
      return cached;
    }
    throw err;
  }

  const field: WindField = { u, v, fetchedAt: Date.now() };
  writeCache(field);
  return field;
}

async function fetchChunk(
  lat: number[],
  lon: number[],
  start: number,
  end: number,
  u: Float32Array,
  v: Float32Array,
): Promise<void> {
  const q = new URLSearchParams({
    latitude: lat.slice(start, end).join(','),
    longitude: lon.slice(start, end).join(','),
    current: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'ms',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q.toString()}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const body = (await res.json()) as
      | Array<{ current?: { wind_speed_10m?: number; wind_direction_10m?: number } }>
      | { current?: { wind_speed_10m?: number; wind_direction_10m?: number } };
    // one-coord chunks return a single object; multi-coord return an array,
    // in the same order as the input
  const arr = Array.isArray(body) ? body : [body];
  for (let k = 0; k < arr.length; k++) {
    const cur = arr[k]?.current;
    const speed = cur?.wind_speed_10m ?? 0;
    const dir = cur?.wind_direction_10m ?? 0;
    // met direction is where wind comes FROM → negate to get flow vector
    u[start + k] = -speed * Math.sin(dir * DEG);
    v[start + k] = -speed * Math.cos(dir * DEG);
  }
}

/**
 * Bilinear sample at (lat, lon). Longitude wraps; latitude clamps to the grid.
 * Writes [u, v] into `out`; returns the speed magnitude.
 */
export function sampleUV(field: WindField, lat: number, lon: number, out: [number, number]): number {
  const fr = (lat - LAT_MIN) / STEP;
  const fc = (((lon - LON_MIN) % 360) + 360) % 360 / STEP;
  const r0 = Math.floor(fr);
  const c0 = Math.floor(fc);
  const tr = fr - r0;
  const tc = fc - c0;
  if (r0 < 0 || r0 >= NLAT - 1) {
    out[0] = 0;
    out[1] = 0;
    return 0;
  }
  const r1 = r0 + 1;
  const c1 = (c0 + 1) % NLON;
  const i00 = r0 * NLON + c0, i01 = r0 * NLON + c1;
  const i10 = r1 * NLON + c0, i11 = r1 * NLON + c1;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const u = lerp(lerp(field.u[i00]!, field.u[i01]!, tc), lerp(field.u[i10]!, field.u[i11]!, tc), tr);
  const v = lerp(lerp(field.v[i00]!, field.v[i01]!, tc), lerp(field.v[i10]!, field.v[i11]!, tc), tr);
  out[0] = u;
  out[1] = v;
  return Math.hypot(u, v);
}
