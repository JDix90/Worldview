/**
 * Normalized aircraft state — the one shape every source adapter emits and
 * everything downstream (hot state, rollups, detectors, client) consumes.
 * SI units throughout: meters, m/s, degrees true.
 */

export type SourceId = 'opensky' | 'adsbfi';

export interface AircraftState {
  /** ICAO24 Mode-S address, lowercase hex. */
  hex: string;
  callsign?: string;
  lat: number;
  lon: number;
  altBaroM?: number;
  altGeoM?: number;
  groundSpeedMs?: number;
  /** True track over ground, degrees 0-359. */
  trackDeg?: number;
  verticalRateMs?: number;
  onGround: boolean;
  squawk?: string;
  /** ADS-B emergency/priority status (adsb.fi only): none, general, lifeguard… */
  emergency?: string;
  /** ADS-B emitter category, e.g. "A3". */
  category?: string;
  /** Origin country (OpenSky only, receiver-registry derived). */
  originCountry?: string;
  /** Navigation Integrity Category (adsb.fi only) — the GPS-interference input. */
  nic?: number;
  /** Radius of containment, meters (adsb.fi only). */
  rc?: number;
  /** Epoch seconds of last position update. */
  seenAt: number;
  source: SourceId;
}

export interface GlobalSnapshot {
  /** Epoch seconds, as reported by the source. */
  fetchedAt: number;
  source: SourceId;
  aircraft: AircraftState[];
}
