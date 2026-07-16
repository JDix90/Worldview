/**
 * D2 — emergency squawks (FOUNDATION §7, DECISIONS #4). Baseline-free, runs
 * from day one. Pure function over (sightings, prior state):
 *
 *  7500 (hijack)        → graduated (DECISIONS #52, calibration find of
 *                          2026-07-16: ~12 false S1s/day from aggregator-cache
 *                          staleness — seenAt advances on position messages
 *                          while a stale squawk value lingers in one network's
 *                          cache):
 *                            S1 only when CORROBORATED — seen by BOTH OpenSky
 *                            and adsb.fi within the window, across ≥3
 *                            independent observations spanning ≥3 minutes.
 *                            A cache artifact lives in one aggregator; a real
 *                            hijack transponder shows in both.
 *                            Uncorroborated/shorter persistence (≥2 obs) → S2.
 *  7600 (radio failure) → S3 on first sight
 *  7700 (emergency)     → S3 on first sight; 2+ aircraft within 500 km inside
 *                          30 min is a cluster → S2 (that's when it stops being
 *                          a routine medical diversion)
 *
 * Emission dedupe is the emitter's job (dedupeKey); this module just decides
 * what conditions exist right now.
 */
import type { Severity } from '@orrery/shared';

export type EmergencyCode = '7500' | '7600' | '7700';

export interface SquawkSighting {
  hex: string;
  lat: number;
  lon: number;
  callsign?: string;
  seenAt: number;
  onGround?: boolean;
  /** Which networks reported this sighting THIS cycle (jobDetect merge sets these). */
  srcOpenSky?: boolean;
  srcAdsbfi?: boolean;
}

interface TrackedSquawk {
  code: EmergencyCode;
  firstS: number;
  lastS: number;
  /**
   * Count of INDEPENDENT observations (strictly advancing seenAt), not
   * detect cycles. The detect job (60s) outpaces the OpenSky snapshot (90s),
   * so two cycles can read the same observation — counting cycles let a
   * single transient 7500 masquerade as "persistent" (found live 2026-07-16).
   */
  cycles: number;
  /** seenAt of the newest observation counted into `cycles`. */
  lastDataS: number;
  /** seenAt of the first observation in this persistence window. */
  firstDataS: number;
  /** Networks that reported this squawk at any point in the window. */
  seenOpenSky: boolean;
  seenAdsbfi: boolean;
  lat: number;
  lon: number;
  callsign?: string;
}

export interface D2State {
  entries: Record<string, TrackedSquawk>; // key: `${hex}:${code}`
}

export interface D2Event {
  kind: 'squawk_7500' | 'squawk_7600' | 'squawk_7700' | 'squawk_7700_cluster';
  severity: Severity;
  hexes: string[];
  lat: number;
  lon: number;
  what: string;
  confidence: number;
  dedupeKey: string;
}

/** A cycle gap longer than this breaks "consecutive". */
const CONSECUTIVE_GAP_S = 150;
/** 7500 must persist this many observations before it emits at all (S2). */
const HIJACK_MIN_OBS = 2;
/** S1 additionally requires this many observations spanning this much data time… */
const HIJACK_S1_OBS = 3;
const HIJACK_S1_SPAN_S = 180;
/** …and corroboration by BOTH networks (see header). */
const ENTRY_TTL_S = 1800;
const CLUSTER_RADIUS_KM = 500;

const DEG = Math.PI / 180;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function detectSquawks(
  nowS: number,
  bySquawk: Record<EmergencyCode, SquawkSighting[]>,
  state: D2State,
): { events: D2Event[]; state: D2State } {
  const entries = { ...state.entries };
  const events: D2Event[] = [];

  for (const code of ['7500', '7600', '7700'] as const) {
    for (const s of bySquawk[code] ?? []) {
      // ramp/taxi transponder activity is noise at this instrument's altitude
      if (s.onGround) continue;
      const key = `${s.hex}:${code}`;
      const prev = entries[key];
      const consecutive = prev !== undefined && nowS - prev.lastS <= CONSECUTIVE_GAP_S;
      const newObservation = !consecutive || s.seenAt > prev.lastDataS;
      entries[key] = {
        code,
        firstS: consecutive ? prev.firstS : nowS,
        lastS: nowS,
        cycles: consecutive ? prev.cycles + (newObservation ? 1 : 0) : 1,
        lastDataS: consecutive ? Math.max(prev.lastDataS, s.seenAt) : s.seenAt,
        firstDataS: consecutive ? prev.firstDataS : s.seenAt,
        seenOpenSky: (consecutive && prev.seenOpenSky) || s.srcOpenSky === true,
        seenAdsbfi: (consecutive && prev.seenAdsbfi) || s.srcAdsbfi === true,
        lat: s.lat,
        lon: s.lon,
        callsign: s.callsign ?? prev?.callsign,
      };
      const e = entries[key];
      const label = e.callsign ?? s.hex;

      if (code === '7500' && e.cycles >= HIJACK_MIN_OBS) {
        const spanS = e.lastDataS - e.firstDataS;
        const corroborated = e.seenOpenSky && e.seenAdsbfi;
        const spanMin = Math.max(1, Math.round(spanS / 60));
        if (corroborated && e.cycles >= HIJACK_S1_OBS && spanS >= HIJACK_S1_SPAN_S) {
          events.push({
            kind: 'squawk_7500',
            severity: 'S1',
            hexes: [s.hex],
            lat: s.lat,
            lon: s.lon,
            what: `${label} squawking 7500 (unlawful interference) — corroborated by both networks, ${e.cycles} observations over ${spanMin} min.`,
            confidence: Math.min(0.95, 0.75 + 0.05 * (e.cycles - HIJACK_S1_OBS)),
            dedupeKey: `d2:7500:${s.hex}:s1`, // distinct from the S2 latch so escalation isn't suppressed
          });
        } else {
          events.push({
            kind: 'squawk_7500',
            severity: 'S2',
            hexes: [s.hex],
            lat: s.lat,
            lon: s.lon,
            what: `${label} squawking 7500 (unlawful interference), ${e.cycles} observation(s)${corroborated ? '' : ', single network'} — below the corroborated-S1 bar, watching.`,
            confidence: 0.5,
            dedupeKey: `d2:7500:${s.hex}`,
          });
        }
      } else if (code === '7600') {
        events.push({
          kind: 'squawk_7600',
          severity: 'S3',
          hexes: [s.hex],
          lat: s.lat,
          lon: s.lon,
          what: `${label} squawking 7600 (radio failure).`,
          confidence: 0.7,
          dedupeKey: `d2:7600:${s.hex}`,
        });
      } else if (code === '7700') {
        events.push({
          kind: 'squawk_7700',
          severity: 'S3',
          hexes: [s.hex],
          lat: s.lat,
          lon: s.lon,
          what: `${label} squawking 7700 (general emergency).`,
          confidence: 0.7,
          dedupeKey: `d2:7700:${s.hex}`,
        });
      }
    }
  }

  // expire stale entries
  for (const [key, e] of Object.entries(entries)) {
    if (nowS - e.lastS > ENTRY_TTL_S) delete entries[key];
  }

  // 7700 clustering over everything still active
  const active7700 = Object.entries(entries).filter(([, e]) => e.code === '7700');
  const clustered = new Set<string>();
  for (let i = 0; i < active7700.length; i++) {
    for (let j = i + 1; j < active7700.length; j++) {
      const [, a] = active7700[i]!;
      const [, b] = active7700[j]!;
      if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= CLUSTER_RADIUS_KM) {
        clustered.add(active7700[i]![0]);
        clustered.add(active7700[j]![0]);
      }
    }
  }
  if (clustered.size >= 2) {
    const members = [...clustered].sort();
    const hexes = members.map((k) => k.split(':')[0]!);
    const lat = members.reduce((s, k) => s + entries[k]!.lat, 0) / members.length;
    const lon = members.reduce((s, k) => s + entries[k]!.lon, 0) / members.length;
    events.push({
      kind: 'squawk_7700_cluster',
      severity: 'S2',
      hexes,
      lat,
      lon,
      what: `${hexes.length} aircraft squawking 7700 within ${CLUSTER_RADIUS_KM} km of each other inside 30 min — not a routine diversion pattern.`,
      confidence: 0.8,
      dedupeKey: `d2:7700cluster:${hexes.join(',')}`,
    });
  }

  return { events, state: { entries } };
}
