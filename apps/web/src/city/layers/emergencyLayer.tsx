/**
 * EMERGENCY — IPAWS non-weather alerts near home (round 1 L7, #125): AMBER,
 * civil danger/emergency, law-enforcement, evacuation, shelter, hazmat.
 * Weather never renders here (NWS layer's job — the server proxy filters).
 * Exception-based and expected to be invisible for weeks at a time; only
 * alerts whose polygon reaches within ~100 mi of home count (a national feed
 * must not light a Denver chip for an Oregon AMBER). Ringless alerts are
 * dropped — v1 honesty over guessing geometry from area names.
 */
import { apiGet } from '../../feed/api';
import { toPx, type CityLayerDef, type CityPick, type MercatorView } from '../registry';

export interface IpawsAlert {
  identifier: string;
  event: string;
  headline: string | null;
  areaDesc: string | null;
  expiresMs: number | null;
  rings: number[][][];
}

interface EmergencyData {
  alerts: IpawsAlert[];
}

const MAGENTA = '#ff7ad9';
const NEAR_DEG = 1.5; // ~100 mi

function makeFetch(home: { lat: number; lon: number }) {
  return apiGet<{ alerts: IpawsAlert[] }>('/api/proxy/ipaws').then((d) => ({
    alerts: (d.alerts ?? []).filter((a) =>
      a.rings.some((ring) =>
        ring.some(([lon, lat]) => Math.abs(lat! - home.lat) < NEAR_DEG && Math.abs(lon! - home.lon) < NEAR_DEG),
      ),
    ),
  }));
}

function centroid(ring: number[][]): { lat: number; lon: number } {
  let lat = 0, lon = 0;
  for (const [x, y] of ring as [number, number][]) { lon += x; lat += y; }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

export const emergencyLayer: CityLayerDef<EmergencyData> = {
  id: 'emergency',
  label: 'EMERGENCY',
  chipColor: MAGENTA,
  defaultOn: true,
  describe: 'IPAWS civil alerts near home — AMBER, evacuation, hazmat… (rare by design)',
  attribution: 'emergency: FEMA IPAWS',

  fetchEager: makeFetch as unknown as (home: { lat: number; lon: number }) => Promise<EmergencyData>,
  pollWhileOpenMs: 5 * 60_000,

  count: (d) => d.alerts.length,
  hasContent: (d) => d.alerts.length > 0,

  pickables: (d, view: MercatorView) =>
    d.alerts
      .filter((a) => a.rings.length > 0)
      .map((a) => {
        const c = centroid(a.rings[0]!);
        return { item: a, ...toPx(view, c.lat, c.lon) };
      }),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.alerts.map((a, i) =>
        a.rings.map((ring, j) => {
          const pts = ring.map(([lon, lat]) => toPx(view, lat!, lon!));
          const path = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z';
          const sel = picked?.layerId === 'emergency' && picked.item === a;
          return (
            <path
              key={`${i}-${j}`}
              d={path}
              fill={MAGENTA}
              fillOpacity={0.1}
              stroke={MAGENTA}
              strokeWidth={sel ? 2.5 : 1.5}
              strokeOpacity={0.85}
              strokeDasharray="6 3"
            />
          );
        }),
      )}
    </>
  ),

  detail: (item) => {
    const a = item as IpawsAlert;
    const until = a.expiresMs ? new Date(a.expiresMs).toISOString().slice(11, 16) + 'Z' : null;
    return (
      <span>
        <span style={{ color: MAGENTA }}>⬢ {a.event}</span>
        <span style={{ opacity: 0.65 }}>
          {a.areaDesc && ` · ${a.areaDesc}`}
          {until && ` · until ${until}`}
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: MAGENTA }}>⬢</span> {d.alerts.length} civil alert{d.alerts.length === 1 ? '' : 's'}
    </span>
  ),
};
