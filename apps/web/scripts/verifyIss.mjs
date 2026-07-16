// Validate the satWorker math path: CelesTrak TLE + satellite.js vs live ISS truth
import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js';

const tleText = await (await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle')).text();
const lines = tleText.split('\n').map(l => l.trimEnd());
const idx = lines.findIndex(l => l.includes('ISS (ZARYA)'));
if (idx < 0) throw new Error('ISS not in stations group');
const rec = twoline2satrec(lines[idx + 1], lines[idx + 2]);

const truth = await (await fetch('https://api.wheretheiss.at/v1/satellites/25544')).json();
const now = new Date(truth.timestamp * 1000);
const gmst = gstime(now);
const pv = propagate(rec, now);
const geo = eciToGeodetic(pv.position, gmst);
const lat = degreesLat(geo.latitude), lon = degreesLong(geo.longitude);

const dLat = Math.abs(lat - truth.latitude);
const dLon = Math.abs(((lon - truth.longitude + 540) % 360) - 180);
console.log(`ours:  lat ${lat.toFixed(2)} lon ${lon.toFixed(2)} alt ${geo.height.toFixed(0)} km`);
console.log(`truth: lat ${truth.latitude.toFixed(2)} lon ${truth.longitude.toFixed(2)} alt ${truth.altitude.toFixed(0)} km`);
console.log(`delta: ${dLat.toFixed(3)}° lat, ${dLon.toFixed(3)}° lon → ${dLat < 1 && dLon < 1 ? 'PASS (<1°)' : 'FAIL'}`);
