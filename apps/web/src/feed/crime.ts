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
    const bbox = `${lon - 0.15},${lat - 0.12},${lon + 0.15},${lat + 0.12}`;
    const params = new URLSearchParams({
      where: `REPORTED_DATE >= DATE '${since}' AND IS_CRIME = 1`,
      outFields: 'OFFENSE_CATEGORY_ID,OFFENSE_TYPE_ID,REPORTED_DATE,INCIDENT_ADDRESS',
      geometry: bbox,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      resultRecordCount: '2000',
      f: 'geojson',
    });
    const res = await fetch(`${DENVER_QUERY_URL}?${params}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Denver crime query: HTTP ${res.status}`);
    const data = (await res.json()) as ArcGisGeoJson;
    const out: CrimeIncident[] = [];
    for (const f of data.features ?? []) {
      const coords = f.geometry?.coordinates;
      const p = f.properties ?? {};
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
      if (typeof p.REPORTED_DATE !== 'number') continue;
      const category = p.OFFENSE_CATEGORY_ID ?? 'unknown';
      out.push({
        lon: coords[0],
        lat: coords[1],
        category,
        group: groupOf(category),
        type: p.OFFENSE_TYPE_ID ?? category,
        address: p.INCIDENT_ADDRESS ?? '',
        reportedAtMs: p.REPORTED_DATE,
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
