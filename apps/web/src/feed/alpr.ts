/**
 * ALPR (license-plate reader) locations near home — the CAMERAS layer of the
 * CITY map. Pure client-side furniture (#46): the keyless Overpass API over
 * OpenStreetMap's community surveillance mapping (the DeFlock project).
 * CORS `*` verified live 2026-07-23; 449 nodes in the Denver home bbox, 374
 * of them Flock Safety.
 *
 * Honesty contract: this is crowdsourced mapping — a floor, not a census.
 * Every surface that renders it must say "community-mapped · incomplete".
 * Unlike the crime feed there is no registry gate: OSM is global, so this
 * works wherever home is set.
 */

export interface AlprCamera {
  lat: number;
  lon: number;
  /** Manufacturer/brand when tagged (e.g. "Flock Safety"), else null. */
  brand: string | null;
  operator: string | null;
  /** "public" | "private" | … when tagged. */
  operatorType: string | null;
  /** View heading in degrees (0 = north) when tagged — drives the view cone. */
  directionDeg: number | null;
  /** e.g. "entrance", "street" when tagged. */
  zone: string | null;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

interface OverpassNode {
  type: string;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

async function fetchAlpr(lat: number, lon: number): Promise<AlprCamera[]> {
  // Same footprint as the crime bbox (~±8 mi at Denver's latitude).
  const bbox = `${lat - 0.12},${lon - 0.15},${lat + 0.12},${lon + 0.15}`;
  const query = `[out:json][timeout:20];
node["man_made"="surveillance"]["surveillance:type"="ALPR"](${bbox});
out body;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Overpass: HTTP ${res.status}`);
  const data = (await res.json()) as { elements?: OverpassNode[] };
  const out: AlprCamera[] = [];
  for (const el of data.elements ?? []) {
    if (el.type !== 'node' || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const t = el.tags ?? {};
    const dir = Number(t.direction);
    out.push({
      lat: el.lat!,
      lon: el.lon!,
      brand: t.manufacturer ?? t.brand ?? null,
      operator: t.operator ?? null,
      operatorType: t['operator:type'] ?? null,
      directionDeg: Number.isFinite(dir) ? ((dir % 360) + 360) % 360 : null,
      zone: t['surveillance:zone'] ?? null,
    });
  }
  return out;
}

export function flockCount(cams: AlprCamera[]): number {
  return cams.filter((c) => (c.brand ?? '').toLowerCase().includes('flock')).length;
}

// ── Cache ─────────────────────────────────────────────────────────────────
// Static infrastructure: 24 h TTL = one Overpass query per home per day,
// which is the polite cadence for a shared community API.
const cache = new Map<string, { at: number; data: AlprCamera[] }>();
const TTL_MS = 24 * 3600_000;

export async function fetchAlprCached(lat: number, lon: number): Promise<AlprCamera[]> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await fetchAlpr(lat, lon);
  cache.set(key, { at: Date.now(), data });
  return data;
}
