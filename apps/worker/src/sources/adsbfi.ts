/**
 * adsb.fi adapter — the sharp-edged detectors' source (FOUNDATION §3):
 * global squawk queries and point-radius integrity sweeps, ADSBx-v2 format
 * with nav-integrity fields. All calls are serialized through a rate gate
 * that keeps us provably under their 1 req/s public limit.
 */
import type { AircraftState } from '@orrery/shared';
import { env } from '../env.js';

/** 1200ms between calls — a deliberate 20% margin under the 1 req/s limit. */
const MIN_GAP_MS = 1200;

let lastRequestAtMs = 0;
let gate: Promise<unknown> = Promise.resolve();

function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const waitMs = lastRequestAtMs + MIN_GAP_MS - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    lastRequestAtMs = Date.now();
    return fn();
  });
  gate = run.catch(() => undefined); // one failed call must not jam the gate
  return run;
}

interface AdsbfiAircraft {
  hex?: string;
  flight?: string;
  t?: string; // airframe type code
  desc?: string; // long human type name, e.g. "BOEING KC-135R Stratotanker"
  ownOp?: string; // owner/operator
  r?: string; // registration
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  nic?: number;
  rc?: number;
  seen_pos?: number;
}

interface AdsbfiResponse {
  ac?: AdsbfiAircraft[];
  now?: number; // epoch milliseconds
  msg?: string;
}

const KT_TO_MS = 0.514444;
const FT_TO_M = 0.3048;
const FPM_TO_MS = 0.00508;

// adsb.fi's desc/ownOp are already human-readable ("Boeing C-17A Globemaster
// III", "Department Of The Air Force (USAF)"). Case is inconsistent but any
// normalization mangles model codes (KC-135R/T) or acronyms (USAF) — so we
// pass them through verbatim, just trimmed/emptied.
const clean = (s: string | undefined): string | undefined => s?.trim() || undefined;

function normalize(ac: AdsbfiAircraft, nowSec: number): AircraftState | null {
  if (!ac.hex || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  return {
    hex: ac.hex.toLowerCase(),
    callsign: ac.flight?.trim() || undefined,
    typeCode: ac.t,
    typeDesc: clean(ac.desc),
    operator: clean(ac.ownOp),
    registration: ac.r?.trim() || undefined,
    lat: ac.lat,
    lon: ac.lon,
    altBaroM: typeof ac.alt_baro === 'number' ? ac.alt_baro * FT_TO_M : undefined,
    altGeoM: typeof ac.alt_geom === 'number' ? ac.alt_geom * FT_TO_M : undefined,
    groundSpeedMs: typeof ac.gs === 'number' ? ac.gs * KT_TO_MS : undefined,
    trackDeg: typeof ac.track === 'number' ? ac.track : undefined,
    verticalRateMs: typeof ac.baro_rate === 'number' ? ac.baro_rate * FPM_TO_MS : undefined,
    onGround: ac.alt_baro === 'ground',
    squawk: ac.squawk,
    emergency: ac.emergency,
    category: ac.category,
    nic: ac.nic,
    rc: ac.rc,
    seenAt: nowSec - (typeof ac.seen_pos === 'number' ? ac.seen_pos : 0),
    source: 'adsbfi',
  };
}

export interface AdsbfiResult {
  fetchedAt: number;
  aircraft: AircraftState[];
  raw: unknown;
}

async function get(pathname: string): Promise<AdsbfiResult> {
  return rateLimited(async () => {
    const res = await fetch(`${env.adsbfiBaseUrl}${pathname}`, {
      headers: { 'user-agent': 'ORRERY (personal, non-commercial; single instance)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`adsb.fi ${pathname}: HTTP ${res.status}`);
    const data = (await res.json()) as AdsbfiResponse;
    const nowSec = typeof data.now === 'number' ? Math.floor(data.now / 1000) : Math.floor(Date.now() / 1000);
    const aircraft = (data.ac ?? [])
      .map((ac) => normalize(ac, nowSec))
      .filter((a): a is AircraftState => a !== null);
    return { fetchedAt: nowSec, aircraft, raw: data };
  });
}

export function fetchBySquawk(code: string): Promise<AdsbfiResult> {
  return get(`/v2/sqk/${code}`);
}

export function fetchRadius(lat: number, lon: number, radiusNm: number): Promise<AdsbfiResult> {
  return get(`/v3/lat/${lat}/lon/${lon}/dist/${radiusNm}`);
}

/** All military-flagged aircraft (adsb.fi maintains the registry flag). */
export function fetchMil(): Promise<AdsbfiResult> {
  return get('/v2/mil');
}
