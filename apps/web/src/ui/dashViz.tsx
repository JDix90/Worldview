/**
 * Small SVG micro-visuals for the HOME dashboard (2026-07-22, DECISIONS #111).
 * Each renders from data the modal already fetches — no new server surface
 * (DECISIONS #97). Kept deliberately tiny: a glance, not a chart.
 */

const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const DIM = 'rgba(143,163,184,0.6)';
const FAINT = 'rgba(79,216,255,0.22)';

// ── Overhead radar ────────────────────────────────────────────────────────
// Plots the nearest aircraft (overhead.tops) by true bearing + distance on a
// north-up polar scope. Rings at 50/100/150 mi; military amber, civil cyan.
const COMPASS_DEG: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

export interface RadarBlip {
  distMi: number;
  bearing: string;
  mil: boolean;
}

export function OverheadRadar({ blips }: { blips: RadarBlip[] }) {
  const R = 46; // scope radius (px)
  const MAX_MI = 150;
  const S = R + 14; // half viewbox — leaves room for cardinal labels
  const rings = [50, 100, 150];

  return (
    <svg width={S * 2} height={S * 2} viewBox={`${-S} ${-S} ${S * 2} ${S * 2}`} style={{ display: 'block' }}>
      {rings.map((mi) => (
        <circle key={mi} cx={0} cy={0} r={(mi / MAX_MI) * R} fill="none" stroke={FAINT} strokeWidth={1} />
      ))}
      {/* cross-hairs */}
      <line x1={-R} y1={0} x2={R} y2={0} stroke={FAINT} strokeWidth={1} />
      <line x1={0} y1={-R} x2={0} y2={R} stroke={FAINT} strokeWidth={1} />
      {/* cardinal ticks */}
      {(['N', 'E', 'S', 'W'] as const).map((c) => {
        const deg = COMPASS_DEG[c]!;
        const a = deg * (Math.PI / 180);
        const lx = Math.sin(a) * (R + 8);
        const ly = -Math.cos(a) * (R + 8);
        return (
          <text
            key={c}
            x={lx}
            y={ly}
            fontSize={8}
            fill={DIM}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="ui-monospace, Menlo, monospace"
          >
            {c}
          </text>
        );
      })}
      {/* you */}
      <circle cx={0} cy={0} r={2} fill={CYAN} />
      {/* aircraft */}
      {blips.map((b, i) => {
        const deg = COMPASS_DEG[b.bearing];
        if (deg === undefined) return null;
        const a = deg * (Math.PI / 180);
        const r = (Math.min(b.distMi, MAX_MI) / MAX_MI) * R;
        const x = Math.sin(a) * r;
        const y = -Math.cos(a) * r;
        return <circle key={i} cx={x} cy={y} r={2.6} fill={b.mil ? AMBER : CYAN} opacity={0.95} />;
      })}
    </svg>
  );
}

// ── Moon phase disc ───────────────────────────────────────────────────────
// Draws tonight's true illuminated fraction. Built from unambiguous pieces
// (no reliance on arc sweep flags): a lit right half-disc, plus a terminator
// ellipse that is lit for a gibbous moon (adds the near-left) or dark for a
// crescent (carves the right down to a sliver). Mirrored for a waning moon —
// waxing is lit on the right (Northern-Hemisphere convention).
const MOON_LIGHT = '#e8eef3';
const MOON_DARK = '#12181f';
const MOON_EDGE = 'rgba(143,163,184,0.35)';

export function MoonDisc({ illumination, waxing, size = 34 }: { illumination: number; waxing: boolean; size?: number }) {
  const R = size / 2 - 1;
  const k = Math.min(1, Math.max(0, illumination));
  const rx = R * Math.abs(1 - 2 * k); // terminator half-width; 0 at quarter
  const rightHalf = `M 0 ${-R} A ${R} ${R} 0 0 1 0 ${R} Z`; // sweep 1 = right limb
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} style={{ display: 'block', flexShrink: 0 }}>
      {/* base geometry is lit-on-the-left; waxing (lit right) is the mirror */}
      <g transform={waxing ? 'scale(-1,1)' : undefined}>
        <circle cx={0} cy={0} r={R} fill={MOON_DARK} />
        <path d={rightHalf} fill={MOON_LIGHT} />
        {/* gibbous → lit ellipse fills toward the dark limb; crescent → dark ellipse eats into the lit half */}
        <ellipse cx={0} cy={0} rx={rx} ry={R} fill={k > 0.5 ? MOON_LIGHT : MOON_DARK} />
      </g>
      <circle cx={0} cy={0} r={R} fill="none" stroke={MOON_EDGE} strokeWidth={0.75} />
    </svg>
  );
}

// ── AQI band gauge ────────────────────────────────────────────────────────
// A banded good→hazardous scale with a marker at the current AQI. Scale tops
// out at 300 (hazardous begins); higher values pin to the right edge.
const AQI_BANDS: Array<{ upto: number; color: string }> = [
  { upto: 50, color: '#6be36b' },
  { upto: 100, color: '#ffb300' },
  { upto: 150, color: '#ff9d4d' },
  { upto: 200, color: '#ff5a5a' },
  { upto: 300, color: '#c86bff' },
];
const AQI_MAX = 300;

export function AqiBar({ aqi }: { aqi: number }) {
  const W = 200;
  const H = 6;
  const pos = Math.min(aqi, AQI_MAX) / AQI_MAX;
  let prev = 0;
  return (
    <svg width={W} height={H + 9} viewBox={`0 0 ${W} ${H + 9}`} style={{ display: 'block', marginTop: 3 }}>
      {AQI_BANDS.map((b) => {
        const x = (prev / AQI_MAX) * W;
        const w = ((b.upto - prev) / AQI_MAX) * W;
        prev = b.upto;
        return <rect key={b.upto} x={x} y={0} width={w} height={H} fill={b.color} opacity={0.55} rx={1} />;
      })}
      {/* marker */}
      <polygon
        points={`${pos * W - 3},${H + 8} ${pos * W + 3},${H + 8} ${pos * W},${H + 2}`}
        fill="#e8eef3"
      />
      <line x1={pos * W} y1={0} x2={pos * W} y2={H} stroke="#e8eef3" strokeWidth={1.5} />
    </svg>
  );
}
