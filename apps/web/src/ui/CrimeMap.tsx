/**
 * City-level crime map (DECISIONS #113): a centered modal with a hand-rolled
 * static OSM tile mosaic (no map dependency — owner choice over Leaflet),
 * crime dots projected in SVG on top, zoom presets instead of pan/zoom.
 * Tiles are dimmed/inverted to match the instrument's dark aesthetic;
 * © OpenStreetMap attribution shown as the tile policy requires.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CrimeIncident, CrimeGroup } from '../feed/crime';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const RED = '#ff5a5a';
const DIM = 'rgba(143,163,184,0.85)';

const GROUP_COLOR: Record<CrimeGroup, string> = {
  violent: RED,
  property: AMBER,
  other: 'rgba(143,163,184,0.75)',
};
const GROUP_LABEL: Record<CrimeGroup, string> = {
  violent: 'violent',
  property: 'property',
  other: 'other',
};

// Map viewport (px). Tiles are 256px; ~3×2 visible grid plus bleed.
const MAP_W = 656;
const MAP_H = 400;
const TILE = 256;

// Zoom presets: CITY ≈ ±12 mi across at Denver's latitude, NEIGHBORHOOD ≈ ±3 mi.
const PRESETS = [
  { id: 'city', label: 'CITY', z: 11 },
  { id: 'hood', label: 'NEIGHBORHOOD', z: 13 },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];

/** Web-Mercator: lon/lat → world coordinates in tile units at zoom z. */
function worldXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "theft-of-motor-vehicle" → "theft of motor vehicle" */
function humanize(id: string): string {
  return id.replace(/-/g, ' ');
}

interface Props {
  incidents: CrimeIncident[];
  home: { lat: number; lon: number };
  homeLabel: string;
  sourceLabel: string;
  attribution: string;
  days: number;
  onClose: () => void;
}

export function CrimeMap({ incidents, home, homeLabel, sourceLabel, attribution, days, onClose }: Props) {
  const [preset, setPreset] = useState<PresetId>('city');
  const [picked, setPicked] = useState<CrimeIncident | null>(null);
  const z = PRESETS.find((p) => p.id === preset)!.z;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Center the viewport on home; world→viewport pixel offset.
  const center = worldXY(home.lat, home.lon, z);
  const originPxX = center.x * TILE - MAP_W / 2;
  const originPxY = center.y * TILE - MAP_H / 2;

  // Tile grid covering the viewport.
  const tiles = useMemo(() => {
    const n = 2 ** z;
    const x0 = Math.floor(originPxX / TILE);
    const y0 = Math.floor(originPxY / TILE);
    const x1 = Math.floor((originPxX + MAP_W) / TILE);
    const y1 = Math.floor((originPxY + MAP_H) / TILE);
    const out: Array<{ x: number; y: number; left: number; top: number }> = [];
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        out.push({
          x: ((tx % n) + n) % n, // wrap antimeridian
          y: ty,
          left: tx * TILE - originPxX,
          top: ty * TILE - originPxY,
        });
      }
    }
    return out;
  }, [z, originPxX, originPxY]);

  // Project incidents to viewport px; keep only on-screen ones.
  const dots = useMemo(
    () =>
      incidents
        .map((inc) => {
          const w = worldXY(inc.lat, inc.lon, z);
          return { inc, px: w.x * TILE - originPxX, py: w.y * TILE - originPxY };
        })
        .filter((d) => d.px >= -4 && d.px <= MAP_W + 4 && d.py >= -4 && d.py <= MAP_H + 4),
    [incidents, z, originPxX, originPxY],
  );

  const counts = useMemo(() => {
    const c: Record<CrimeGroup, number> = { violent: 0, property: 0, other: 0 };
    for (const i of incidents) c[i.group]++;
    return c;
  }, [incidents]);

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: CrimeIncident | null = null;
    let bestD = 10; // px pick radius
    for (const d of dots) {
      const dist = Math.hypot(d.px - mx, d.py - my);
      if (dist < bestD) { bestD = dist; best = d.inc; }
    }
    setPicked(best);
  };

  const stacked = picked ? incidents.filter((i) => i.address === picked.address).length - 1 : 0;

  // Portal to <body>: the HOME panel's backdrop-filter creates a containing
  // block, which would trap this "fixed" modal inside the scrolling panel.
  return createPortal(
    <>
      {/* scrim */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 50 }}
      />
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%,-50%)',
          width: `min(92vw, ${MAP_W + 28}px)`,
          zIndex: 51,
          font: `11px/1.6 ${mono}`,
          color: 'rgba(200,214,229,0.92)',
          background: 'rgba(6,10,16,0.97)',
          border: '1px solid rgba(79,216,255,0.3)',
          borderRadius: 5,
          padding: '10px 14px 8px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>CRIME</span>
          <span style={{ opacity: 0.7 }}>last {days} days · {incidents.length} reported near {homeLabel}</span>
          <span style={{ flex: 1 }} />
          {PRESETS.map((p) => (
            <span
              key={p.id}
              onClick={() => { setPreset(p.id); setPicked(null); }}
              style={{
                cursor: 'pointer',
                padding: '1px 7px',
                border: `1px solid ${preset === p.id ? 'rgba(79,216,255,0.5)' : 'rgba(79,216,255,0.18)'}`,
                borderRadius: 3,
                color: preset === p.id ? CYAN : DIM,
                fontSize: 10,
              }}
            >
              {p.label}
            </span>
          ))}
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6, marginLeft: 4 }}>✕</span>
        </div>

        {/* map */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: MAP_W,
            height: MAP_H,
            margin: '0 auto',
            overflow: 'hidden',
            borderRadius: 3,
            background: '#0a0f16',
          }}
        >
          {tiles.map((t) => (
            <img
              key={`${z}/${t.x}/${t.y}`}
              src={`https://tile.openstreetmap.org/${z}/${t.x}/${t.y}.png`}
              width={TILE}
              height={TILE}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              style={{
                position: 'absolute',
                left: t.left,
                top: t.top,
                // Dark-map treatment: invert + hue-rotate is the standard recipe,
                // but inverting OSM turns its white roads black against an
                // already-dark ground — so keep brightness/contrast UP or the
                // street network disappears entirely (verified in-browser).
                filter: 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(1.15) contrast(1.3)',
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            />
          ))}
          {/* tint to sink the basemap behind the dots */}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(6,10,16,0.12)', pointerEvents: 'none' }} />
          <svg
            width="100%"
            height={MAP_H}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
            onClick={pick}
          >
            {dots.map((d, i) => (
              <circle
                key={i}
                cx={d.px}
                cy={d.py}
                r={picked === d.inc ? 4.5 : 3}
                fill={GROUP_COLOR[d.inc.group]}
                opacity={0.85}
                stroke={picked === d.inc ? '#e8eef3' : 'none'}
                strokeWidth={picked === d.inc ? 1.2 : 0}
              />
            ))}
            {/* home marker — same amber ringed-dot as the overhead radar */}
            <circle cx={MAP_W / 2} cy={MAP_H / 2} r={5} fill="none" stroke="#ffd27f" strokeWidth={1.4} />
            <circle cx={MAP_W / 2} cy={MAP_H / 2} r={1.8} fill="#ffd27f" />
            <text
              x={MAP_W / 2}
              y={MAP_H / 2 + 15}
              fontSize={9}
              fill="#ffd27f"
              textAnchor="middle"
              fontFamily={mono}
              style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.8)', strokeWidth: 2 }}
            >
              {homeLabel}
            </text>
          </svg>
          {/* attribution (tile policy requirement) */}
          <div
            style={{
              position: 'absolute',
              right: 4,
              bottom: 2,
              fontSize: 9,
              color: 'rgba(200,214,229,0.55)',
              textShadow: '0 1px 2px rgba(0,0,0,0.9)',
              pointerEvents: 'none',
            }}
          >
            map © OpenStreetMap contributors
          </div>
        </div>

        {/* legend + detail strip */}
        <div style={{ display: 'flex', gap: 12, marginTop: 6, alignItems: 'baseline' }}>
          {(Object.keys(GROUP_COLOR) as CrimeGroup[]).map((g) => (
            <span key={g} style={{ fontSize: 10, opacity: 0.85 }}>
              <span style={{ color: GROUP_COLOR[g] }}>●</span> {GROUP_LABEL[g]} {counts[g]}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, opacity: 0.45 }}>{attribution}</span>
        </div>
        <div style={{ minHeight: 18, marginTop: 2 }}>
          {picked ? (
            <span>
              <span style={{ color: GROUP_COLOR[picked.group] }}>{humanize(picked.type)}</span>
              <span style={{ opacity: 0.65 }}>
                {' '}· {picked.address || 'location withheld'} · reported {ago(picked.reportedAtMs)}
                {stacked > 0 && ` · +${stacked} more at this block`}
              </span>
            </span>
          ) : (
            <span style={{ opacity: 0.4 }}>click a dot for details · source: {sourceLabel}</span>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
