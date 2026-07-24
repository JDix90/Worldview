/**
 * Decoder check against the LIVE RTD feed (one fetch).
 * Run: pnpm dlx tsx apps/server/scripts/verifyGtfsrt.ts
 */
import { decodeVehicleFeed } from '../src/gtfsrt';

const URL = 'https://www.rtd-denver.com/files/gtfs-rt/VehiclePosition.pb';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const res = await fetch(URL, { headers: { 'user-agent': 'ORRERY (personal, non-commercial)' } });
check('RTD feed fetch', res.ok, `HTTP ${res.status}`);
const buf = new Uint8Array(await res.arrayBuffer());
check('feed non-trivial', buf.length > 10_000, `${buf.length} bytes`);

const vehicles = decodeVehicleFeed(buf);
check('decoded a fleet', vehicles.length > 50, `${vehicles.length} vehicles`);

const inColorado = vehicles.filter((v) => v.lat > 38.5 && v.lat < 41 && v.lon > -106 && v.lon < -103.5);
check('≥95% positions inside Colorado bounds', inColorado.length / vehicles.length >= 0.95,
  `${inColorado.length}/${vehicles.length}`);

const withRoute = vehicles.filter((v) => v.routeId);
check('most vehicles carry route_id', withRoute.length / vehicles.length > 0.6,
  `${withRoute.length}/${vehicles.length}`);

const fresh = vehicles.filter((v) => v.tsSec && Date.now() / 1000 - v.tsSec < 600);
check('positions are fresh (<10 min)', fresh.length / vehicles.length > 0.8,
  `${fresh.length}/${vehicles.length}`);

console.log('sample:', JSON.stringify(vehicles.slice(0, 3), null, 1));
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
