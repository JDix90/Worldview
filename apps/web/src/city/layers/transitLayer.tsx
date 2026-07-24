/**
 * TRANSIT — live RTD vehicle positions (round 1 L5, #125). Server-decoded
 * GTFS-Realtime via /api/proxy/transit (30s cache); triangles rotated to
 * bearing, rail lines bright, buses dim. Default OFF — it's a dense lens you
 * choose, not ambient furniture. Positions only, honestly labeled: this feed
 * carries no predictions.
 */
import { apiGet } from '../../feed/api';
import { toPx, onScreen, type CityLayerDef, type CityPick, type MercatorView } from '../registry';

export interface TransitVehicle {
  id: string;
  label: string | null;
  routeId: string | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  tsSec: number | null;
}

interface TransitData {
  vehicles: TransitVehicle[];
  fetchedAt: number;
}

const RAIL = '#4fd8ff';
const BUS = 'rgba(160,190,210,0.75)';

/** RTD rail routes are lettered (A/B/D/E/H/L/N/R/W, incl. 402L MallRide-ish
 *  exceptions kept as bus); buses are numeric. Cheap, honest split. */
function isRail(routeId: string | null): boolean {
  return !!routeId && /^[A-Z]$/.test(routeId);
}

export const transitLayer: CityLayerDef<TransitData> = {
  id: 'transit',
  label: 'TRANSIT',
  chipColor: RAIL,
  defaultOn: false,
  describe: 'live RTD vehicle positions — positions, not predictions',
  attribution: 'transit: RTD GTFS-Realtime',

  fetchEager: () => apiGet<TransitData>('/api/proxy/transit'),
  pollWhileOpenMs: 30_000,

  count: (d) => d.vehicles.length,

  pickables: (d, view: MercatorView) =>
    d.vehicles.map((v) => ({ item: v, ...toPx(view, v.lat, v.lon) })).filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.vehicles.map((v) => {
        const p = toPx(view, v.lat, v.lon);
        if (!onScreen(view, p, 8)) return null;
        const sel = picked?.layerId === 'transit' && picked.item === v;
        const col = isRail(v.routeId) ? RAIL : BUS;
        const s = sel ? 6 : 4.5;
        const rot = v.bearingDeg ?? 0;
        return (
          <path
            key={v.id}
            d={`M 0 ${-s} L ${s * 0.7} ${s} L ${-s * 0.7} ${s} Z`}
            transform={`translate(${p.x} ${p.y}) rotate(${rot})`}
            fill={col}
            opacity={0.9}
            stroke={sel ? '#e8eef3' : 'none'}
            strokeWidth={sel ? 1.2 : 0}
          />
        );
      })}
    </>
  ),

  detail: (item) => {
    const v = item as TransitVehicle;
    const ageS = v.tsSec ? Math.max(0, Math.round(Date.now() / 1000 - v.tsSec)) : null;
    return (
      <span>
        <span style={{ color: isRail(v.routeId) ? RAIL : BUS }}>
          ▲ {v.routeId ? `route ${v.routeId}` : 'vehicle'}
        </span>
        <span style={{ opacity: 0.65 }}>
          {v.label && ` · #${v.label}`}
          {isRail(v.routeId) ? ' · rail' : ' · bus'}
          {ageS !== null && ` · position ${ageS}s old`}
        </span>
      </span>
    );
  },

  legend: (d) => {
    const rail = d.vehicles.filter((v) => isRail(v.routeId)).length;
    return (
      <span style={{ fontSize: 10, opacity: 0.85 }}>
        <span style={{ color: RAIL }}>▲</span> {d.vehicles.length} vehicles ({rail} rail)
        <span style={{ opacity: 0.55 }}> · positions, not predictions</span>
      </span>
    );
  },
};
