/**
 * CAMERAS — community-mapped ALPRs (OSM/DeFlock via Overpass, #122), as a
 * CityLayerDef (#125). Squares + view-cone wedges; behavior unchanged.
 * Honesty contract stands: labeled community-mapped/incomplete everywhere.
 */
import { fetchAlprCached, flockCount, type AlprCamera } from '../../feed/alpr';
import { toPx, onScreen, type CityLayerDef, type CityPick } from '../registry';

const CAM_COLOR = '#bfe8f5';

function compass16(deg: number): string {
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(deg / 22.5) % 16]!;
}

export const camerasLayer: CityLayerDef<AlprCamera[]> = {
  id: 'cameras',
  label: 'CAMERAS',
  chipColor: CAM_COLOR,
  defaultOn: true,
  describe: 'license-plate readers — OSM community-mapped (DeFlock); incomplete',
  attribution: 'cameras © OpenStreetMap contributors · community-mapped, incomplete',

  fetchEager: (home) => fetchAlprCached(home.lat, home.lon),

  count: (d) => d.length,

  pickables: (d, view) =>
    d.map((cam) => ({ item: cam, ...toPx(view, cam.lat, cam.lon) })).filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {/* view-cones under the squares */}
      {d.map((cam, i) => {
        if (cam.directionDeg === null) return null;
        const p = toPx(view, cam.lat, cam.lon);
        if (!onScreen(view, p)) return null;
        const a1 = ((cam.directionDeg - 15) * Math.PI) / 180;
        const a2 = ((cam.directionDeg + 15) * Math.PI) / 180;
        return (
          <path
            key={`w${i}`}
            d={`M ${p.x} ${p.y} L ${p.x + 16 * Math.sin(a1)} ${p.y - 16 * Math.cos(a1)} A 16 16 0 0 1 ${
              p.x + 16 * Math.sin(a2)} ${p.y - 16 * Math.cos(a2)} Z`}
            fill={CAM_COLOR}
            opacity={0.14}
          />
        );
      })}
      {d.map((cam, i) => {
        const p = toPx(view, cam.lat, cam.lon);
        if (!onScreen(view, p)) return null;
        const sel = picked?.layerId === 'cameras' && picked.item === cam;
        const s = sel ? 3.2 : 2.2;
        return (
          <rect
            key={`c${i}`}
            x={p.x - s}
            y={p.y - s}
            width={2 * s}
            height={2 * s}
            fill={CAM_COLOR}
            opacity={0.9}
            stroke={sel ? '#e8eef3' : 'none'}
            strokeWidth={sel ? 1.2 : 0}
          />
        );
      })}
    </>
  ),

  detail: (item) => {
    const cam = item as AlprCamera;
    return (
      <span>
        <span style={{ color: CAM_COLOR }}>ALPR camera</span>
        <span style={{ opacity: 0.65 }}>
          {cam.brand && ` · ${cam.brand}`}
          {cam.operator && ` · operated by ${cam.operator}${cam.operatorType ? ` (${cam.operatorType})` : ''}`}
          {cam.directionDeg !== null && ` · faces ${compass16(cam.directionDeg)}`}
          {cam.zone && ` · ${cam.zone}`}
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: CAM_COLOR }}>■</span> ALPR {d.length} · {flockCount(d)} Flock
      <span style={{ opacity: 0.55 }}> · community-mapped, incomplete</span>
    </span>
  ),
};
