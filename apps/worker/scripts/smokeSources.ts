/**
 * Standalone adapter smoke test — exercises both source adapters against the
 * live APIs without Redis/BullMQ. Run: pnpm --filter @orrery/worker smoke:sources
 */
import { fetchGlobalSnapshot } from '../src/sources/opensky.js';
import { fetchBySquawk, fetchRadius } from '../src/sources/adsbfi.js';
import { GPS_WATCH_REGIONS } from '@orrery/shared';

const t0 = Date.now();

console.log('— OpenSky global snapshot —');
const os = await fetchGlobalSnapshot();
const withTrack = os.snapshot.aircraft.filter((a) => a.trackDeg !== undefined).length;
console.log({
  aircraft: os.snapshot.aircraft.length,
  withTrack,
  anonymous: os.anonymous,
  creditsRemaining: os.creditsRemaining,
  sample: os.snapshot.aircraft.find((a) => a.callsign && !a.onGround),
});

console.log('— adsb.fi squawk 7700 —');
const sq = await fetchBySquawk('7700');
console.log({ aircraft: sq.aircraft.length, hexes: sq.aircraft.map((a) => a.hex) });

console.log('— adsb.fi integrity tile (first Baltic tile) —');
const tile = GPS_WATCH_REGIONS[0]!.tiles[0]!;
const sweep = await fetchRadius(tile.lat, tile.lon, tile.radiusNm);
const withNic = sweep.aircraft.filter((a) => a.nic !== undefined);
console.log({
  aircraft: sweep.aircraft.length,
  withNic: withNic.length,
  lowNic: withNic.filter((a) => (a.nic as number) <= 4).length,
  sample: withNic[0],
});

// Rate gate proof: two more adsb.fi calls back-to-back must be spaced ≥1.2s.
const g0 = Date.now();
await fetchBySquawk('7600');
await fetchBySquawk('7500');
console.log('— rate gate: 2 calls took', Date.now() - g0, 'ms (must be ≥ 1200) —');

console.log('smoke complete in', Date.now() - t0, 'ms');
