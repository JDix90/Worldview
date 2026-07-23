/**
 * The CITY map (DECISIONS #113, #124): a centered modal with a hand-rolled
 * static OSM tile mosaic (no map dependency — owner choice over Leaflet) and
 * layer chips over one shared surface: CRIME (7-day incidents) and CAMERAS
 * (community-mapped ALPR/plate readers via Overpass — a floor, not a census).
 * Zoom presets instead of pan/zoom. Tiles dimmed/inverted to the instrument
 * aesthetic; © OpenStreetMap attribution as the tile policy requires.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CrimeIncident, CrimeGroup } from '../feed/crime';
import { flockCount, type AlprCamera } from '../feed/alpr';

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

function compass16(deg: number): string {
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(deg / 22.5) % 16]!;
}

const CAM_COLOR = '#bfe8f5';

type Picked = { kind: 'crime'; inc: CrimeIncident } | { kind: 'camera'; cam: AlprCamera };

/** Which data layers are lit. Persisted — the map remembers what you watch. */
interface LayerState { crime: boolean; cameras: boolean }
const LAYERS_KEY = 'orrery:citymap:layers';
function loadLayers(): LayerState {
  try {
    return { crime: true, cameras: true, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Partial<LayerState>) };
  } catch {
    return { crime: true, cameras: true };
  }
}

interface Props {
  /** Either layer may be 'unavailable' (upstream failure) — the other must
   *  keep working. Verified the hard way: Denver ArcGIS timed out during
   *  this feature's own verification while Overpass was healthy (#122). */
  incidents: CrimeIncident[] | 'unavailable';
  cameras: AlprCamera[] | 'unavailable';
  home: { lat: number; lon: number };
  homeLabel: string;
  sourceLabel: string;
  attribution: string;
  days: number;
  onClose: () => void;
}

export function CrimeMap({ incidents, cameras, home, homeLabel, sourceLabel, attribution, days, onClose }: Props) {
  const [preset, setPreset] = useState<PresetId>('city');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [layers, setLayers] = useState<LayerState>(loadLayers);
  const z = PRESETS.find((p) => p.id === preset)!.z;
  const camList = Array.isArray(cameras) ? cameras : [];
  const incList = Array.isArray(incidents) ? incidents : [];

  const toggleLayer = (k: keyof LayerState) => {
    setLayers((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem(LAYERS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
    setPicked(null);
  };

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
      incList
        .map((inc) => {
          const w = worldXY(inc.lat, inc.lon, z);
          return { inc, px: w.x * TILE - originPxX, py: w.y * TILE - originPxY };
        })
        .filter((d) => d.px >= -4 && d.px <= MAP_W + 4 && d.py >= -4 && d.py <= MAP_H + 4),
    [incList, z, originPxX, originPxY],
  );

  // Cameras projected the same way (static infrastructure, same footprint).
  const camDots = useMemo(
    () =>
      camList
        .map((cam) => {
          const w = worldXY(cam.lat, cam.lon, z);
          return { cam, px: w.x * TILE - originPxX, py: w.y * TILE - originPxY };
        })
        .filter((d) => d.px >= -4 && d.px <= MAP_W + 4 && d.py >= -4 && d.py <= MAP_H + 4),
    [camList, z, originPxX, originPxY],
  );

  const counts = useMemo(() => {
    const c: Record<CrimeGroup, number> = { violent: 0, property: 0, other: 0 };
    for (const i of incList) c[i.group]++;
    return c;
  }, [incList]);

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: Picked | null = null;
    let bestD = 10; // px pick radius
    if (layers.crime) {
      for (const d of dots) {
        const dist = Math.hypot(d.px - mx, d.py - my);
        if (dist < bestD) { bestD = dist; best = { kind: 'crime', inc: d.inc }; }
      }
    }
    if (layers.cameras) {
      for (const d of camDots) {
        const dist = Math.hypot(d.px - mx, d.py - my);
        if (dist < bestD) { bestD = dist; best = { kind: 'camera', cam: d.cam }; }
      }
    }
    setPicked(best);
  };

  const stacked =
    picked?.kind === 'crime'
      ? incList.filter((i) => i.address === picked.inc.address).length - 1
      : 0;

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
        {/* header: title, data-layer chips, zoom presets */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>CITY</span>
          <span style={{ opacity: 0.7 }}>near {homeLabel}</span>
          <span
            onClick={() => toggleLayer('crime')}
            title={`Reported crimes, last ${days} days`}
            style={{
              cursor: 'pointer',
              padding: '1px 7px',
              border: `1px solid ${layers.crime ? 'rgba(255,179,0,0.55)' : 'rgba(143,163,184,0.25)'}`,
              borderRadius: 3,
              color: layers.crime ? AMBER : DIM,
              fontSize: 10,
            }}
          >
            CRIME {incidents === 'unavailable' ? '—' : incList.length}
          </span>
          <span
            onClick={() => toggleLayer('cameras')}
            title="License-plate readers — OSM community-mapped (DeFlock); incomplete"
            style={{
              cursor: 'pointer',
              padding: '1px 7px',
              border: `1px solid ${layers.cameras ? 'rgba(191,232,245,0.55)' : 'rgba(143,163,184,0.25)'}`,
              borderRadius: 3,
              color: layers.cameras ? CAM_COLOR : DIM,
              fontSize: 10,
            }}
          >
            CAMERAS {cameras === 'unavailable' ? '—' : camList.length}
          </span>
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
            {/* camera view-cones under everything, then squares; crime dots on top */}
            {layers.cameras &&
              camDots.map((d, i) =>
                d.cam.directionDeg === null ? null : (
                  <path
                    key={`w${i}`}
                    d={`M ${d.px} ${d.py} L ${d.px + 16 * Math.sin(((d.cam.directionDeg - 15) * Math.PI) / 180)} ${
                      d.py - 16 * Math.cos(((d.cam.directionDeg - 15) * Math.PI) / 180)
                    } A 16 16 0 0 1 ${d.px + 16 * Math.sin(((d.cam.directionDeg + 15) * Math.PI) / 180)} ${
                      d.py - 16 * Math.cos(((d.cam.directionDeg + 15) * Math.PI) / 180)
                    } Z`}
                    fill={CAM_COLOR}
                    opacity={0.14}
                  />
                ),
              )}
            {layers.cameras &&
              camDots.map((d, i) => {
                const sel = picked?.kind === 'camera' && picked.cam === d.cam;
                const s = sel ? 3.2 : 2.2;
                return (
                  <rect
                    key={`c${i}`}
                    x={d.px - s}
                    y={d.py - s}
                    width={2 * s}
                    height={2 * s}
                    fill={CAM_COLOR}
                    opacity={0.9}
                    stroke={sel ? '#e8eef3' : 'none'}
                    strokeWidth={sel ? 1.2 : 0}
                  />
                );
              })}
            {layers.crime &&
              dots.map((d, i) => {
                const sel = picked?.kind === 'crime' && picked.inc === d.inc;
                return (
                  <circle
                    key={i}
                    cx={d.px}
                    cy={d.py}
                    r={sel ? 4.5 : 3}
                    fill={GROUP_COLOR[d.inc.group]}
                    opacity={0.85}
                    stroke={sel ? '#e8eef3' : 'none'}
                    strokeWidth={sel ? 1.2 : 0}
                  />
                );
              })}
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
            map{layers.cameras ? ' + camera data' : ''} © OpenStreetMap contributors
          </div>
        </div>

        {/* legend + detail strip */}
        <div style={{ display: 'flex', gap: 12, marginTop: 6, alignItems: 'baseline' }}>
          {layers.crime &&
            (Object.keys(GROUP_COLOR) as CrimeGroup[]).map((g) => (
              <span key={g} style={{ fontSize: 10, opacity: 0.85 }}>
                <span style={{ color: GROUP_COLOR[g] }}>●</span> {GROUP_LABEL[g]} {counts[g]}
              </span>
            ))}
          {layers.cameras && (
            <span style={{ fontSize: 10, opacity: 0.85 }}>
              <span style={{ color: CAM_COLOR }}>■</span>{' '}
              {cameras === 'unavailable'
                ? 'ALPR data unavailable'
                : `ALPR ${camList.length} · ${flockCount(camList)} Flock`}
              <span style={{ opacity: 0.55 }}> · community-mapped, incomplete</span>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, opacity: 0.45 }}>{attribution}</span>
        </div>
        <div style={{ minHeight: 18, marginTop: 2 }}>
          {picked?.kind === 'crime' ? (
            <span>
              <span style={{ color: GROUP_COLOR[picked.inc.group] }}>{humanize(picked.inc.type)}</span>
              <span style={{ opacity: 0.65 }}>
                {' '}· {picked.inc.address || 'location withheld'} · reported {ago(picked.inc.reportedAtMs)}
                {stacked > 0 && ` · +${stacked} more at this block`}
              </span>
            </span>
          ) : picked?.kind === 'camera' ? (
            <span>
              <span style={{ color: CAM_COLOR }}>ALPR camera</span>
              <span style={{ opacity: 0.65 }}>
                {picked.cam.brand && ` · ${picked.cam.brand}`}
                {picked.cam.operator &&
                  ` · operated by ${picked.cam.operator}${picked.cam.operatorType ? ` (${picked.cam.operatorType})` : ''}`}
                {picked.cam.directionDeg !== null && ` · faces ${compass16(picked.cam.directionDeg)}`}
                {picked.cam.zone && ` · ${picked.cam.zone}`}
              </span>
            </span>
          ) : (
            <span style={{ opacity: 0.4 }}>
              click a dot for details · crime: {sourceLabel} · cameras: OSM/DeFlock
            </span>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
