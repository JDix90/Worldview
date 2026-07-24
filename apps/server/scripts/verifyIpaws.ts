/**
 * IPAWS parser checks: live feed (one fetch) + synthetic AMBER/civil blocks.
 * Run: pnpm dlx tsx apps/server/scripts/verifyIpaws.ts
 */
import { parseIpaws, fetchIpaws } from '../src/ipaws';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const NOW = Date.parse('2026-07-24T02:00:00Z');
const wrap = (inner: string) => `<?xml version="1.0"?><alerts><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">${inner}</alert></alerts>`;

// 1. AMBER with polygon survives the filter and parses the ring.
const amber = wrap(`
<identifier>TEST-AMBER-1</identifier><status>Actual</status><msgType>Alert</msgType>
<info><event>AMBER Alert</event><headline>Test abduction alert</headline>
<expires>2026-07-24T06:00:00Z</expires>
<area><areaDesc>Denver metro</areaDesc><polygon>39.6,-105.1 39.9,-105.1 39.9,-104.8 39.6,-104.8 39.6,-105.1</polygon></area></info>`);
const a1 = parseIpaws(amber, NOW);
check('AMBER parses', a1.length === 1 && a1[0]!.event === 'AMBER Alert');
check('polygon ring lon,lat order', a1.length === 1 && a1[0]!.rings[0]![0]![0] === -105.1 && a1[0]!.rings[0]![0]![1] === 39.6,
  JSON.stringify(a1[0]?.rings[0]?.[0]));

// 2. Weather event is filtered out (NWS layer's job).
const wx = wrap(`
<identifier>TEST-WX</identifier><status>Actual</status><msgType>Alert</msgType>
<info><event>Flash Flood Warning</event><expires>2026-07-24T06:00:00Z</expires></info>`);
check('weather event filtered', parseIpaws(wx, NOW).length === 0);

// 3. Expired civil alert dropped.
const expired = wrap(`
<identifier>TEST-EXP</identifier><status>Actual</status><msgType>Alert</msgType>
<info><event>Civil Emergency Message</event><expires>2026-07-23T01:00:00Z</expires></info>`);
check('expired alert dropped', parseIpaws(expired, NOW).length === 0);

// 4. Exercise/System status dropped.
const exercise = wrap(`
<identifier>TEST-EX</identifier><status>Exercise</status><msgType>Alert</msgType>
<info><event>Civil Danger Warning</event><expires>2026-07-24T06:00:00Z</expires></info>`);
check('Exercise status dropped', parseIpaws(exercise, NOW).length === 0);

// 5. Live feed: fetch parses without throwing; count reported (usually 0 —
//    non-weather alerts are rare, which is the point).
try {
  const live = await fetchIpaws();
  check('live IPAWS fetch+parse', true, `${live.length} non-weather alerts right now`);
  if (live.length) console.log('sample:', JSON.stringify(live[0], null, 1).slice(0, 300));
} catch (e) {
  check('live IPAWS fetch+parse', false, String(e));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
