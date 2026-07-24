/**
 * FEMA IPAWS → non-weather emergency alerts (round 1 L7, #125). The public
 * REST feed returns CAP 1.2 XML (verified keyless 2026-07-23, polygons
 * included). Weather stays the NWS layer's job — this surfaces ONLY the rare
 * civil layer band: AMBER, civil danger/emergency, law enforcement warning,
 * evacuation, shelter-in-place, hazmat, 911 outage.
 *
 * Parsed with anchored regexes rather than an XML dependency: CAP blocks are
 * flat, namespaced-but-regular, and the fields we lift are five. Same
 * no-deps taste as the GTFS-RT reader.
 */

export interface IpawsAlert {
  identifier: string;
  event: string;
  headline: string | null;
  areaDesc: string | null;
  expiresMs: number | null;
  /** [[ [lon,lat], … ]] rings — CAP polygons are "lat,lon lat,lon …". */
  rings: number[][][];
}

const NON_WEATHER_EVENTS =
  /amber|child abduction|civil danger|civil emergency|law enforcement|evacuat|shelter|hazardous material|hazmat|911|telephone outage|local area emergency|radiological|nuclear|blue alert/i;

function field(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1]!.trim() : null;
}

export function parseIpaws(xml: string, nowMs: number): IpawsAlert[] {
  const out: IpawsAlert[] = [];
  const blocks = xml.split(/<alert[\s>]/).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, raw.indexOf('</alert>') + 8);
    const status = field(block, 'status');
    const msgType = field(block, 'msgType');
    if (status !== 'Actual' || (msgType !== 'Alert' && msgType !== 'Update')) continue;
    const event = field(block, 'event');
    if (!event || !NON_WEATHER_EVENTS.test(event)) continue;
    const expires = field(block, 'expires');
    const expiresMs = expires ? Date.parse(expires) : null;
    if (expiresMs !== null && expiresMs < nowMs) continue;
    const rings: number[][][] = [];
    for (const pm of block.matchAll(/<polygon>([^<]+)<\/polygon>/g)) {
      const ring = pm[1]!
        .trim()
        .split(/\s+/)
        .map((pair) => {
          const [lat, lon] = pair.split(',').map(Number);
          return [lon!, lat!];
        })
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (ring.length >= 3) rings.push(ring);
    }
    out.push({
      identifier: field(block, 'identifier') ?? `${event}-${expiresMs}`,
      event,
      headline: field(block, 'headline'),
      areaDesc: field(block, 'areaDesc'),
      expiresMs,
      rings,
    });
  }
  return out;
}

export async function fetchIpaws(nowMs = Date.now()): Promise<IpawsAlert[]> {
  const since = new Date(nowMs - 24 * 3600_000).toISOString().slice(0, 19) + 'Z';
  const res = await fetch(
    `https://apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/public/recent/${since}`,
    { headers: { 'user-agent': 'ORRERY (personal, non-commercial)' }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`IPAWS HTTP ${res.status}`);
  return parseIpaws(await res.text(), nowMs);
}
