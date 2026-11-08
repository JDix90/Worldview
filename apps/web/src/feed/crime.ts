/**
 * Recently-reported crime near home (DECISIONS #113). Pure client-side
 * furniture: keyless open-data endpoints fetched from the browser, graceful
 * absence when home is outside any covered city. Registry of one (Denver)
 * — adding a city later = one adapter + one registry entry.
 *
 * Denver: ArcGIS FeatureServer on the Denver Open Data Catalog. CORS `*`
 * (verified 2026-07-22), block-level anonymized addresses upstream, updated
 * by Denver PD Mon–Fri.
 */
import { DATA_FOOTPRINT_DEG } from '../city/registry';

export type CrimeGroup = 'violent' | 'property' | 'other';

export interface CrimeIncident {
  lat: number;
  lon: number;
  /** Upstream category id, kebab-case (e.g. "public-disorder"). */
  category: string;
  group: CrimeGroup;
  /** Upstream offense type id, kebab-case (e.g. "theft-of-motor-vehicle"). */
  type: string;
  /** Block-level address as published (already anonymized by the city). */
  address: string;
  reportedAtMs: number;
  /** When the offense actually occurred — often days before it was reported.
   *  null when the upstream omits it. */
  occurredAtMs: number | null;
  /** End of the occurrence window (spanning offenses, e.g. overnight). null
   *  when equal to / absent from the first-occurrence time. */
  occurredEndMs: number | null;
  /** City neighborhood id, kebab-case (e.g. "five-points"). Locates a
   *  block-anonymized address better than the street number alone. */
  neighborhood: string;
  /** Victims on the incident; surfaced only when > 1. */
  victimCount: number | null;
}

export interface CrimeSource {
  id: string;
  label: string;
  attribution: string;
  fetchRecent(lat: number, lon: number, days: number): Promise<CrimeIncident[]>;
}

const VIOLENT = new Set([
  'murder', 'robbery', 'aggravated-assault', 'other-crimes-against-persons', 'sexual-assault',
]);
const PROPERTY = new Set([
  'burglary', 'larceny', 'theft-from-motor-vehicle', 'auto-theft', 'arson',
]);

export function groupOf(category: string): CrimeGroup {
  if (VIOLENT.has(category)) return 'violent';
  if (PROPERTY.has(category)) return 'property';
  return 'other';
}

// ── Retry (DECISIONS #141) ────────────────────────────────────────────────
// Denver's crime query normally answers in ~4 s (cold or warm), but it
// intermittently stalls: on 2026-11-07 one request hit the old 20 s timeout
// and the immediate re-run returned 775 rows in 3.9 s. The layer fetches once
// per home, so a single stall blanked CRIME until reload. Retry instead.
export interface RetryOpts {
  attempts: number;
  timeoutMs: number;
  /** Wait before retry n (n ≥ 1); the last value repeats. */
  backoffMs: readonly number[];
}
const CRIME_RETRY: RetryOpts = { attempts: 3, timeoutMs: 15_000, backoffMs: [1_000, 3_000] };

/** A failure no retry can fix (a 4xx other than 429: the query itself is bad). */
class FatalFetchError extends Error {}

/** GET JSON, retrying stalls, network errors, 429/5xx, unparseable bodies and
 *  ArcGIS's HTTP-200 `{"error": …}` replies (which used to parse as "0
 *  features", i.e. a silent CRIME 0). Throws the last error once attempts run
 *  out. Worst case with CRIME_RETRY: 15+1+15+3+15 ≈ 49 s, then 'unavailable'. */
export async function fetchJsonWithRetry<T>(url: string, label: string, opts: RetryOpts): Promise<T> {
  let lastErr: unknown = new Error(`${label}: no attempts`);
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) {
      const wait = opts.backoffMs[Math.min(i - 1, opts.backoffMs.length - 1)] ?? 0;
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      if (!res.ok) {
        const msg = `${label}: HTTP ${res.status}`;
        throw res.status === 429 || res.status >= 500 ? new Error(msg) : new FatalFetchError(msg);
      }
      const body = (await res.json()) as T | { error?: unknown } | null;
      if (body && typeof body === 'object' && 'error' in body && body.error) throw new Error(`${label}: query error`);
      return body as T;
    } catch (e) {
      if (e instanceof FatalFetchError) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Denver ────────────────────────────────────────────────────────────────
const DENVER_QUERY_URL =
  'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/ODC_CRIME_OFFENSES_P/FeatureServer/324/query';

interface ArcGisGeoJson {
  features?: Array<{
    geometry?: { coordinates?: [number, number] } | null;
    properties?: {
      OFFENSE_CATEGORY_ID?: string;
      OFFENSE_TYPE_ID?: string;
      REPORTED_DATE?: number;
      FIRST_OCCURRENCE_DATE?: number;
      LAST_OCCURRENCE_DATE?: number;
      NEIGHBORHOOD_ID?: string;
      VICTIM_COUNT?: number;
      INCIDENT_ADDRESS?: string;
    };
  }>;
}

const denverSource: CrimeSource = {
  id: 'denver',
  label: 'Denver Open Data',
  attribution: 'data: Denver Open Data (DPD, updated Mon–Fri)',
  async fetchRecent(lat, lon, days) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    // ArcGIS envelope xmin,ymin,xmax,ymax over the shared data footprint (#127).
    const { lat: dLat, lon: dLon } = DATA_FOOTPRINT_DEG;
    const bbox = `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`;
    const params = new URLSearchParams({
      where: `REPORTED_DATE >= DATE '${since}' AND IS_CRIME = 1`,
      outFields:
        'OFFENSE_CATEGORY_ID,OFFENSE_TYPE_ID,REPORTED_DATE,FIRST_OCCURRENCE_DATE,LAST_OCCURRENCE_DATE,NEIGHBORHOOD_ID,VICTIM_COUNT,INCIDENT_ADDRESS',
      geometry: bbox,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      resultRecordCount: '2000',
      f: 'geojson',
    });
    const data = await fetchJsonWithRetry<ArcGisGeoJson>(`${DENVER_QUERY_URL}?${params}`, 'Denver crime query', CRIME_RETRY);
    const out: CrimeIncident[] = [];
    for (const f of data.features ?? []) {
      const coords = f.geometry?.coordinates;
      const p = f.properties ?? {};
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
      if (typeof p.REPORTED_DATE !== 'number') continue;
      const category = p.OFFENSE_CATEGORY_ID ?? 'unknown';
      const first = typeof p.FIRST_OCCURRENCE_DATE === 'number' ? p.FIRST_OCCURRENCE_DATE : null;
      const last = typeof p.LAST_OCCURRENCE_DATE === 'number' ? p.LAST_OCCURRENCE_DATE : null;
      out.push({
        lon: coords[0],
        lat: coords[1],
        category,
        group: groupOf(category),
        type: p.OFFENSE_TYPE_ID ?? category,
        address: p.INCIDENT_ADDRESS ?? '',
        reportedAtMs: p.REPORTED_DATE,
        occurredAtMs: first,
        // only a genuine window (> a minute) is worth showing as a range
        occurredEndMs: last && first && last - first > 60_000 ? last : null,
        neighborhood: p.NEIGHBORHOOD_ID ?? '',
        victimCount: typeof p.VICTIM_COUNT === 'number' ? p.VICTIM_COUNT : null,
      });
    }
    return out;
  },
};

// ── Registry ──────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
function distMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const REGISTRY: Array<{ lat: number; lon: number; radiusMi: number; source: CrimeSource }> = [
  { lat: 39.7392, lon: -104.9903, radiusMi: 25, source: denverSource },
];

/** The crime source covering this home location, or null (quiet absence). */
export function sourceForHome(lat: number, lon: number): CrimeSource | null {
  const hit = REGISTRY.find((r) => distMi(lat, lon, r.lat, r.lon) <= r.radiusMi);
  return hit ? hit.source : null;
}

// ── Cache (10-min TTL, matches the LOCAL CONDITIONS cadence) ─────────────
const cache = new Map<string, { at: number; data: CrimeIncident[] }>();
const TTL_MS = 10 * 60_000;

export async function fetchRecentCached(
  source: CrimeSource,
  lat: number,
  lon: number,
  days: number,
): Promise<CrimeIncident[]> {
  const key = `${source.id}:${lat.toFixed(3)},${lon.toFixed(3)}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await source.fetchRecent(lat, lon, days);
  cache.set(key, { at: Date.now(), data });
  return data;
}
