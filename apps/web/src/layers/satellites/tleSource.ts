/**
 * CelesTrak GP element sets (TLE format), client-direct (keyless, CORS-open).
 *
 * Caching is durable via IndexedDB, NOT localStorage: the Starlink group is
 * ~1.9MB and blows localStorage's ~5MB quota once combined with other groups,
 * so localStorage writes silently failed and every reload re-fetched. CelesTrak
 * answers a re-fetch inside its 2-hour refresh window with an HTTP 403 whose
 * body is "GP data has not updated since your last successful download" — a
 * bandwidth-saver, not a failure. We honor it: on any fetch error we serve the
 * cached copy (stale TLEs propagate fine for a day), and the 12h TTL keeps us
 * from ever hammering inside CelesTrak's window once a group is cached.
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
const CACHE_TTL_MS = 12 * 3600_000;
const memoryCache = new Map<string, { fetchedAt: number; text: string }>();

// ── IndexedDB key/value (one store, keyed by group) ───────────────────
const DB_NAME = 'orrery';
const STORE = 'tle';
type CacheEntry = { fetchedAt: number; text: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(group: string): Promise<CacheEntry | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(group);
      req.onsuccess = () => resolve((req.result as CacheEntry | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(group: string, entry: CacheEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry, group);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* private-mode / quota — memory cache still covers this session */
  }
}

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

async function fetchGroupText(group: string): Promise<string> {
  const now = Date.now();

  const mem = memoryCache.get(group);
  if (mem && now - mem.fetchedAt < CACHE_TTL_MS) return mem.text;

  const cached = await idbGet(group);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    memoryCache.set(group, cached);
    return cached.text;
  }

  try {
    const res = await fetch(`${BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`);
    // CelesTrak's "not updated" reply is 403 with a short text body, not TLEs.
    // Treat any non-2xx (or a suspiciously tiny body) as "keep the cache".
    const text = res.ok ? await res.text() : '';
    if (!res.ok || text.length < 200 || text.startsWith('GP data')) {
      throw new Error(`CelesTrak ${group}: HTTP ${res.status} (no fresh data)`);
    }
    const entry = { fetchedAt: now, text };
    memoryCache.set(group, entry);
    void idbSet(group, entry);
    return text;
  } catch (err) {
    // Serve the last good copy, however old — stale elements still propagate.
    const fallback = cached ?? mem ?? null;
    if (fallback) {
      console.warn(`[satellites] ${group}: using cached TLEs (fetch unavailable)`, err);
      return fallback.text;
    }
    // Cold start inside CelesTrak's refresh window with no cache anywhere: the
    // only real dead end. Surfaces as an empty group until the window passes.
    console.warn(`[satellites] ${group}: no data yet (CelesTrak refresh pending)`, err);
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
    } catch {
      /* group unavailable this cycle — others still render */
    }
  }
  return out;
}
