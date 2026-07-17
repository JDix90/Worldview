/**
 * Callsign → flight route (departure + arrival airports) via adsbdb.com,
 * client-direct (CORS-open, keyless, verified 2026-07-17). OpenSky state
 * vectors carry only the registration country, not the route — this fills in
 * the "from / to" and the coordinates the path overlay draws between.
 *
 * Cached per callsign: routes are stable within a day. Positive hits persist
 * to localStorage (24h TTL); negative hits (GA/military callsigns with no
 * scheduled route) are memoized for the session only, in case data appears
 * later.
 */

export interface RouteEndpoint {
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
}

export interface FlightRoute {
  callsign: string;
  origin: RouteEndpoint;
  destination: RouteEndpoint;
}

const API = 'https://api.adsbdb.com/v0/callsign/';
const CACHE_KEY = 'orrery:routes';
const TTL_MS = 24 * 3600_000;

const mem = new Map<string, FlightRoute | null>();

interface Persisted {
  route: FlightRoute;
  at: number;
}

function loadPersisted(): Record<string, Persisted> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, Persisted>;
  } catch {
    return {};
  }
}

function persist(cs: string, route: FlightRoute): void {
  try {
    const all = loadPersisted();
    all[cs] = { route, at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    /* quota — the in-memory cache still serves this session */
  }
}

interface AdsbdbAirport {
  iata_code?: string;
  icao_code?: string;
  name?: string;
  municipality?: string;
  country_iso_name?: string;
  latitude?: number;
  longitude?: number;
}

function toEndpoint(a: AdsbdbAirport): RouteEndpoint | null {
  if (typeof a.latitude !== 'number' || typeof a.longitude !== 'number') return null;
  return {
    iata: a.iata_code ?? '',
    icao: a.icao_code ?? '',
    name: a.name ?? '',
    city: a.municipality ?? '',
    country: a.country_iso_name ?? '',
    lat: a.latitude,
    lon: a.longitude,
  };
}

export async function fetchRoute(callsign: string | undefined): Promise<FlightRoute | null> {
  const cs = callsign?.trim().toUpperCase();
  if (!cs) return null;
  if (mem.has(cs)) return mem.get(cs)!;

  const persisted = loadPersisted()[cs];
  if (persisted && Date.now() - persisted.at < TTL_MS) {
    mem.set(cs, persisted.route);
    return persisted.route;
  }

  try {
    const res = await fetch(API + encodeURIComponent(cs));
    if (!res.ok) {
      mem.set(cs, null);
      return null;
    }
    const data = (await res.json()) as {
      response?: { flightroute?: { origin?: AdsbdbAirport; destination?: AdsbdbAirport } };
    };
    const fr = data.response?.flightroute;
    const origin = fr?.origin ? toEndpoint(fr.origin) : null;
    const destination = fr?.destination ? toEndpoint(fr.destination) : null;
    if (!origin || !destination) {
      mem.set(cs, null);
      return null;
    }
    const route: FlightRoute = { callsign: cs, origin, destination };
    mem.set(cs, route);
    persist(cs, route);
    return route;
  } catch {
    mem.set(cs, null);
    return null;
  }
}
