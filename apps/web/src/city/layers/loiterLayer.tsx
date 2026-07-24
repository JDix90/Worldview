/**
 * LOITER — aircraft dwelling near home (round 1 L4, #125). The one layer
 * whose data is already on the page: fed by useLoiterWatch's ring buffers
 * over the live ADS-B stores, no upstream at all. Exception-based — nobody
 * circling ⇒ invisible. Trail + pulsing ring; "⤓ fly" in the detail strip
 * points the globe at the aircraft via the existing __ORRERY__ handle.
 */
import { toPx, onScreen, type CityLayerDef, type CityPick, type MercatorView } from '../registry';
import type { LoiterData, LoiterFlag } from '../useLoiterWatch';

const VIOLET = '#c9a7ff';

function bandLabel(altFt: number | null): string {
  if (altFt === null) return '';
  if (altFt < 8_000) return 'low — rotor/survey band';
  return 'high — holding-pattern band';
}

export const loiterLayer: CityLayerDef<LoiterData> = {
  id: 'loiter',
  label: 'LOITER',
  chipColor: VIOLET,
  defaultOn: true,
  describe: 'aircraft dwelling near home — circling, holding, hovering (live, no upstream)',
  attribution: 'loiter: live ADS-B (display heuristic)',

  // Data is pushed by useLoiterWatch — no fetch, no poll.
  count: (d) => d.flags.length,
  hasContent: (d) => d.flags.length > 0,

  pickables: (d, view: MercatorView) =>
    d.flags.map((f) => ({ item: f, ...toPx(view, f.lat, f.lon) })).filter((p) => onScreen(view, p, 20)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.flags.map((f) => {
        const p = toPx(view, f.lat, f.lon);
        const sel = picked?.layerId === 'loiter' && picked.item === f;
        const pts = f.trail.map((s) => toPx(view, s.lat, s.lon));
        const path = pts.map((q, k) => `${k === 0 ? 'M' : 'L'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
        return (
          <g key={f.hex}>
            <path d={path} fill="none" stroke={VIOLET} strokeWidth={1} strokeOpacity={0.45} strokeDasharray="3 2" />
            <circle cx={p.x} cy={p.y} r={sel ? 7 : 6} fill="none" stroke={VIOLET} strokeWidth={1.4} opacity={0.9}>
              <animate attributeName="r" values="4;9;4" dur="2.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0.25;0.9" dur="2.4s" repeatCount="indefinite" />
            </circle>
            <circle cx={p.x} cy={p.y} r={2.4} fill={f.mil ? '#ffb300' : VIOLET} />
            <text
              x={p.x + 9}
              y={p.y - 6}
              fontSize={9}
              fill={VIOLET}
              fontFamily="ui-monospace, Menlo, monospace"
              style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.85)', strokeWidth: 2 }}
            >
              {f.callsign}
            </text>
          </g>
        );
      })}
    </>
  ),

  detail: (item) => {
    const f = item as LoiterFlag;
    const fly = () => {
      const g = (window as { __ORRERY__?: { globe?: { pointOfView(p: object, ms: number): void } } }).__ORRERY__?.globe;
      if (g) g.pointOfView({ lat: f.lat, lng: f.lon, altitude: 0.35 }, 900);
    };
    return (
      <span>
        <span style={{ color: VIOLET }}>◎ {f.callsign}</span>
        {f.mil && <span style={{ color: '#ffb300' }}> MIL</span>}
        <span style={{ opacity: 0.65 }}>
          {' '}· dwelling {f.verdict.dwellMin}m within {f.verdict.radiusMi}mi
          {f.altFt != null && ` · ${f.altFt.toLocaleString()} ft (${bandLabel(f.altFt)})`}
        </span>
        <span onClick={fly} style={{ cursor: 'pointer', color: '#4fd8ff', marginLeft: 8 }} title="Point the globe here">
          ⤓ fly
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: VIOLET }}>◎</span> {d.flags.length} loitering
      <span style={{ opacity: 0.55 }}>
        {' '}· watching {Math.max(1, Math.round((Date.now() - d.watchingSinceMs) / 60_000))}m
      </span>
    </span>
  ),
};
