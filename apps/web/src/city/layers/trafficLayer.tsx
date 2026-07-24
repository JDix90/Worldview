/**
 * TRAFFIC — CDOT/COtrip road incidents near home (round 1 L8, #126). Keyed-
 * free upstream, decoded server-side (/api/proxy/traffic; key never reaches
 * the client, FIRMS precedent #100). Statewide GeoJSON filtered to the home
 * bbox; crashes/closures/fires/activity as points colored by whether a lane
 * is closed. Default ON — the classic "is my route a mess?" glance.
 * Exception-based: no incidents in range ⇒ no chip.
 */
import { apiGet } from '../../feed/api';
import { toPx, onScreen, type CityLayerDef, type CityPick, type MercatorView } from '../registry';

interface CotripFeature {
  geometry?: { type: string; coordinates: number[] | number[][] } | null;
  properties?: {
    id?: string;
    type?: string;
    routeName?: string;
    travelerInformationMessage?: string;
    laneImpacts?: unknown;
    status?: string;
    severity?: string;
    category?: string;
    lastUpdated?: string;
  };
}

export interface TrafficIncident {
  lat: number;
  lon: number;
  type: string;
  route: string | null;
  message: string | null;
  closed: boolean;
  updatedMs: number | null;
}

interface TrafficData {
  incidents: TrafficIncident[];
}

const RED = '#ff5a5a';
const AMBER = '#ffb300';

/** First coordinate of a Point or MultiPoint (COtrip mixes both). */
function firstCoord(g: CotripFeature['geometry']): [number, number] | null {
  if (!g) return null;
  const c = g.coordinates;
  if (g.type === 'Point' && Array.isArray(c) && typeof c[0] === 'number') return [c[0], c[1] as number];
  if (g.type === 'MultiPoint' && Array.isArray(c) && Array.isArray(c[0])) return [c[0][0]!, c[0][1]!];
  return null;
}

function isClosed(p: NonNullable<CotripFeature['properties']>): boolean {
  const hay = `${p.status ?? ''} ${p.severity ?? ''} ${p.category ?? ''} ${JSON.stringify(p.laneImpacts ?? '')} ${p.travelerInformationMessage ?? ''}`.toLowerCase();
  return /closed|closure|blocked|all lanes/.test(hay);
}

function makeFetch(home: { lat: number; lon: number }) {
  return apiGet<{ features?: CotripFeature[] }>('/api/proxy/traffic').then((d) => {
    const incidents: TrafficIncident[] = [];
    for (const f of d.features ?? []) {
      const c = firstCoord(f.geometry);
      if (!c) continue;
      const [lon, lat] = c;
      if (Math.abs(lat - home.lat) > 0.35 || Math.abs(lon - home.lon) > 0.4) continue; // ~25 mi
      const p = f.properties ?? {};
      const updated = p.lastUpdated ? Date.parse(p.lastUpdated) : NaN;
      incidents.push({
        lat,
        lon,
        type: p.type ?? 'incident',
        route: p.routeName ?? null,
        message: p.travelerInformationMessage ?? null,
        closed: isClosed(p),
        updatedMs: Number.isFinite(updated) ? updated : null,
      });
    }
    return { incidents };
  });
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const trafficLayer: CityLayerDef<TrafficData> = {
  id: 'traffic',
  label: 'TRAFFIC',
  chipColor: AMBER,
  defaultOn: true,
  describe: 'CDOT road incidents & closures near home — COtrip',
  attribution: 'traffic: CDOT / COtrip',

  fetchEager: makeFetch as unknown as (home: { lat: number; lon: number }) => Promise<TrafficData>,
  pollWhileOpenMs: 2 * 60_000,

  count: (d) => d.incidents.length,
  hasContent: (d) => d.incidents.length > 0,

  pickables: (d, view: MercatorView) =>
    d.incidents.map((i) => ({ item: i, ...toPx(view, i.lat, i.lon) })).filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.incidents.map((inc, i) => {
        const p = toPx(view, inc.lat, inc.lon);
        if (!onScreen(view, p)) return null;
        const sel = picked?.layerId === 'traffic' && picked.item === inc;
        const col = inc.closed ? RED : AMBER;
        const s = sel ? 5 : 4;
        // a small "⚠" triangle marker
        return (
          <path
            key={i}
            d={`M 0 ${-s} L ${s} ${s} L ${-s} ${s} Z`}
            transform={`translate(${p.x} ${p.y})`}
            fill={col}
            opacity={0.92}
            stroke={sel ? '#e8eef3' : 'rgba(0,0,0,0.5)'}
            strokeWidth={sel ? 1.3 : 0.7}
          />
        );
      })}
    </>
  ),

  detail: (item) => {
    const inc = item as TrafficIncident;
    return (
      <span>
        <span style={{ color: inc.closed ? RED : AMBER }}>▲ {inc.type}{inc.closed ? ' · CLOSURE' : ''}</span>
        <span style={{ opacity: 0.65 }}>
          {inc.route && ` · ${inc.route}`}
          {inc.message && ` · ${inc.message.slice(0, 80)}`}
          {inc.updatedMs && ` · ${ago(inc.updatedMs)}`}
        </span>
      </span>
    );
  },

  legend: (d) => {
    const closed = d.incidents.filter((i) => i.closed).length;
    return (
      <span style={{ fontSize: 10, opacity: 0.85 }}>
        <span style={{ color: AMBER }}>▲</span> {d.incidents.length} incident{d.incidents.length === 1 ? '' : 's'}
        {closed > 0 && <span style={{ color: RED }}> · {closed} closure{closed === 1 ? '' : 's'}</span>}
      </span>
    );
  },
};
