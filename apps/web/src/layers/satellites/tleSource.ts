/**
 * CelesTrak GP element sets (TLE format), client-direct (keyless, CORS-open).
 * Etiquette: 6h cache. Small curated groups persist in localStorage; bulky
 * groups (Starlink ~1.7MB) cache in memory only to spare the quota.
 */

export interface Tle {
  name: string;
  l1: string;
  l2: string;
  noradId: string;
  group: string;
  /** Orbital period in minutes, from the TLE mean motion. */
  periodMin: number;
}

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL_MS = 6 * 3600_000;
const memoryCache = new Map<string, { fetchedAt: number; text: string }>();

function parseTleText(text: string, group: string): Tle[] {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const out: Tle[] = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1?.startsWith('1 ') || !l2?.startsWith('2 ')) break;
    const meanMotion = Number(l2.slice(52, 63));
    out.push({
      name: name.replace(/^0 /, '').trim(),
      l1,
      l2,
      noradId: l1.slice(2, 7).trim(),
      group,
      periodMin: meanMotion > 0 ? 1440 / meanMotion : 0,
    });
  }
  return out;
}

function readStorageCache(group: string): { fetchedAt: number; text: string } | null {
  try {
    const raw = localStorage.getItem(`orrery:tle:${group}`);
    return raw ? (JSON.parse(raw) as { fetchedAt: number; text: string }) : null;
  } catch {
    return null;
  }
}

async function fetchGroupText(group: string): Promise<string> {
  const now = Date.now();

  const mem = memoryCache.get(group);
  if (mem && now - mem.fetchedAt < CACHE_TTL_MS) return mem.text;
  const stored = readStorageCache(group);
  if (stored && now - stored.fetchedAt < CACHE_TTL_MS) return stored.text;

  try {
    const res = await fetch(`${BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`);
    if (!res.ok) throw new Error(`CelesTrak ${group}: HTTP ${res.status}`);
    const text = await res.text();
    memoryCache.set(group, { fetchedAt: now, text });
    try {
      localStorage.setItem(`orrery:tle:${group}`, JSON.stringify({ fetchedAt: now, text }));
    } catch {
      /* quota exceeded (starlink is ~1.7MB) — memory cache still holds it */
    }
    return text;
  } catch (err) {
    // CelesTrak throttles aggressive clients (403) — a stale element set is
    // far better than an empty sky; TLEs stay usable for days
    const fallback = stored ?? memoryCache.get(group) ?? null;
    if (fallback) {
      console.warn(`[satellites] ${group}: fetch failed, using stale cache`, err);
      return fallback.text;
    }
    throw err;
  }
}

/** Fetch several groups, dedupe by NORAD id (first group wins). */
export async function fetchTles(groups: string[]): Promise<Tle[]> {
  const seen = new Set<string>();
  const out: Tle[] = [];
  for (const group of groups) {
    try {
      for (const tle of parseTleText(await fetchGroupText(group), group)) {
        if (!seen.has(tle.noradId)) {
          seen.add(tle.noradId);
          out.push(tle);
        }
      }
    } catch (err) {
      console.warn(`[satellites] group ${group} failed`, err);
    }
  }
  return out;
}
