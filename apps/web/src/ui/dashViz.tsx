/**
 * Small micro-visuals for the HOME dashboard (2026-07-22, DECISIONS #111).
 * Each renders from data the modal already fetches — no new server surface
 * (DECISIONS #97). Kept deliberately tiny: a glance, not a chart.
 */
import { useEffect, useRef } from 'react';

const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const DIM = 'rgba(143,163,184,0.6)';
const FAINT = 'rgba(79,216,255,0.22)';

// ── Overhead radar ────────────────────────────────────────────────────────
// A north-up local scope centred on home. Plots the nearest aircraft at their
// true east/north offset (dxMi/dyMi from the server); the scope auto-zooms to
// the farthest plotted aircraft so nearby traffic spreads out instead of
// piling on the centre dot. Translucent ground plate + home marker underneath.
const COMPASS_DEG: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
// Scope radius snaps up to one of these (mi) so ring labels stay tidy.
const RANGE_STEPS = [5, 10, 15, 25, 50, 75, 100, 150];

export interface RadarBlip {
  distMi: number;
  bearing: string;
  /** East/north miles from home (preferred). Falls back to bearing+distMi. */
  dxMi?: number;
  dyMi?: number;
  mil: boolean;
}

/** East/north miles for a blip — exact offset if present, else derived from
 *  the 16-point compass bearing + distance (older/cached summaries). */
function blipEastNorth(b: RadarBlip): { e: number; n: number } {
  if (typeof b.dxMi === 'number' && typeof b.dyMi === 'number') return { e: b.dxMi, n: b.dyMi };
  const deg = COMPASS_DEG[b.bearing] ?? 0;
  const a = deg * (Math.PI / 180);
  return { e: Math.sin(a) * b.distMi, n: Math.cos(a) * b.distMi };
}

export function OverheadRadar({ blips, homeLabel }: { blips: RadarBlip[]; homeLabel?: string }) {
  const R = 58; // scope radius (px)
  const S = R + 16; // half viewbox — room for cardinal labels
  const pts = blips.map((b) => ({ ...blipEastNorth(b), mil: b.mil }));
  const maxMi = Math.max(0.5, ...pts.map((p) => Math.hypot(p.e, p.n)));
  const scaleMi = RANGE_STEPS.find((s) => s >= maxMi) ?? 150;
  const rings = [scaleMi / 3, (scaleMi * 2) / 3, scaleMi];
  const toXY = (e: number, n: number) => {
    const k = Math.min(1, Math.hypot(e, n) / scaleMi); // clamp to the rim
    const m = Math.hypot(e, n) || 1;
    return { x: (e / m) * k * R, y: -(n / m) * k * R };
  };
  const fmtMi = (mi: number) => Math.round(mi); // integer ring labels read cleaner than 8.3

  return (
    <svg width={S * 2} height={S * 2} viewBox={`${-S} ${-S} ${S * 2} ${S * 2}`} style={{ display: 'block' }}>
      <defs>
        <radialGradient id="radarGround" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(79,216,255,0.12)" />
          <stop offset="70%" stopColor="rgba(79,216,255,0.05)" />
          <stop offset="100%" stopColor="rgba(79,216,255,0.0)" />
        </radialGradient>
      </defs>
      {/* translucent ground plate */}
      <circle cx={0} cy={0} r={R} fill="url(#radarGround)" />
      {/* range rings + labels */}
      {rings.map((mi, i) => {
        const rr = (mi / scaleMi) * R;
        return (
          <g key={i}>
            <circle cx={0} cy={0} r={rr} fill="none" stroke={FAINT} strokeWidth={1} />
            <text
              x={3}
              y={-rr + 1}
              fontSize={6.5}
              fill={DIM}
              opacity={0.7}
              fontFamily="ui-monospace, Menlo, monospace"
            >
              {fmtMi(mi)}
            </text>
          </g>
        );
      })}
      {/* cross-hairs */}
      <line x1={-R} y1={0} x2={R} y2={0} stroke={FAINT} strokeWidth={1} />
      <line x1={0} y1={-R} x2={0} y2={R} stroke={FAINT} strokeWidth={1} />
      {/* cardinal ticks */}
      {(['N', 'E', 'S', 'W'] as const).map((c) => {
        const deg = COMPASS_DEG[c]!;
        const a = deg * (Math.PI / 180);
        return (
          <text
            key={c}
            x={Math.sin(a) * (R + 9)}
            y={-Math.cos(a) * (R + 9)}
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
      {/* aircraft */}
      {pts.map((p, i) => {
        const { x, y } = toXY(p.e, p.n);
        return <circle key={i} cx={x} cy={y} r={2.6} fill={p.mil ? AMBER : CYAN} opacity={0.95} />;
      })}
      {/* home marker (ringed dot, distinct from blips) */}
      <circle cx={0} cy={0} r={3.4} fill="none" stroke="#ffd27f" strokeWidth={1.1} />
      <circle cx={0} cy={0} r={1.3} fill="#ffd27f" />
      {homeLabel && (
        <text
          x={0}
          y={9}
          fontSize={6.5}
          fill="#ffd27f"
          opacity={0.85}
          textAnchor="middle"
          fontFamily="ui-monospace, Menlo, monospace"
        >
          {homeLabel}
        </text>
      )}
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

// ── Crime density preview ─────────────────────────────────────────────────
// A KDE-style heat map of recent incidents around home, drawn on canvas: the
// dashboard's entry point to the full crime map (design review #114 — it used
// to be a 10px text link buried in a junk-drawer section). Same colour ramp as
// the Pi panel's CRIME slide so the two surfaces read as one instrument.
const HEAT_STOPS = [0, 0.15, 0.4, 0.7, 1];
const HEAT_R = [6, 25, 79, 255, 255];
const HEAT_G = [14, 80, 216, 179, 70];
const HEAT_B = [22, 120, 255, 10, 70];
/** Vertical half-span of the preview window, in miles. */
const HEAT_HALF_MI = 8;

function rampAt(t: number, ch: number[]): number {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (t <= HEAT_STOPS[i]!) {
      const span = HEAT_STOPS[i]! - HEAT_STOPS[i - 1]!;
      const f = span > 0 ? (t - HEAT_STOPS[i - 1]!) / span : 0;
      return ch[i - 1]! + f * (ch[i]! - ch[i - 1]!);
    }
  }
  return ch[ch.length - 1]!;
}

export interface HeatPoint {
  lat: number;
  lon: number;
}

export function CrimeHeat({
  points,
  home,
  width,
  height = 92,
}: {
  points: HeatPoint[];
  home: { lat: number; lon: number };
  width: number;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);

    // 1) accumulate density into a float buffer. Canvas 'lighter' compositing
    //    was tried first and clips at 8-bit alpha — with a few hundred city
    //    incidents the core saturates and the map degrades to one flat blob.
    const miPerPx = (2 * HEAT_HALF_MI) / H;
    const cosLat = Math.cos((home.lat * Math.PI) / 180);
    const density = new Float32Array(W * H);
    const sigma = Math.max(3, H / 22);
    const rad = Math.ceil(sigma * 2.5);
    const kernel = new Float32Array((2 * rad + 1) * (2 * rad + 1));
    for (let ky = -rad; ky <= rad; ky++) {
      for (let kx = -rad; kx <= rad; kx++) {
        kernel[(ky + rad) * (2 * rad + 1) + (kx + rad)] =
          Math.exp(-(kx * kx + ky * ky) / (2 * sigma * sigma));
      }
    }
    for (const p of points) {
      const dx = (p.lon - home.lon) * 69.0 * cosLat;
      const dy = (p.lat - home.lat) * 69.0;
      const cx = Math.round(W / 2 + dx / miPerPx);
      const cy = Math.round(H / 2 - dy / miPerPx);
      const x0 = Math.max(0, cx - rad);
      const x1 = Math.min(W - 1, cx + rad);
      const y0 = Math.max(0, cy - rad);
      const y1 = Math.min(H - 1, cy + rad);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          density[y * W + x]! += kernel[(y - cy + rad) * (2 * rad + 1) + (x - cx + rad)]!;
        }
      }
    }

    // 2) normalise and map through the ramp
    let peak = 0;
    for (let i = 0; i < density.length; i++) if (density[i]! > peak) peak = density[i]!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < density.length; i++) {
      const t = peak > 0 ? Math.pow(density[i]! / peak, 0.55) : 0;
      const o = i * 4;
      d[o] = rampAt(t, HEAT_R);
      d[o + 1] = rampAt(t, HEAT_G);
      d[o + 2] = rampAt(t, HEAT_B);
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // 3) home marker — matches OverheadRadar's ringed amber dot
    ctx.strokeStyle = '#ffd27f';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 4 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd27f';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 1.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }, [points, home.lat, home.lon, width, height]);

  return (
    <canvas
      ref={ref}
      style={{ width, height, display: 'block', borderRadius: 2 }}
      aria-label="Recent crime density near home"
    />
  );
}
