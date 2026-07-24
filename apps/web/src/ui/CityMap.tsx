/**
 * The CITY map (#113 crime → #122 cameras → #125 layer framework): a centered
 * modal with a hand-rolled OSM tile mosaic and N data layers, each a
 * CityLayerDef (city/registry.ts). This file is deliberately a thin
 * orchestrator — mosaic, chips, drawer, pick dispatch, detail strip — and
 * knows nothing about any specific layer.
 *
 * Chip grammar (the accretion guardrail): a chip renders only when its layer
 * is enabled AND has content (exception-based layers vanish when empty); the
 * trailing ⊞ chip opens a drawer listing every layer with toggles. Zoom is
 * two presets, not pan/zoom. Tiles dimmed/inverted; © OSM attribution per
 * tile policy.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TILE,
  worldXY,
  tileGrid,
  loadEnabledCity,
  saveEnabledCity,
  type CityLayerDef,
  type CityPick,
  type MercatorView,
} from '../city/registry';
import type { CityMapState } from '../feed/useCityMap';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const CYAN = '#4fd8ff';
const DIM = 'rgba(143,163,184,0.85)';

const MAP_W = 656;
const MAP_H = 400;

const PRESETS = [
  { id: 'city', label: 'CITY', z: 11 },
  { id: 'hood', label: 'NEIGHBORHOOD', z: 13 },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];

interface Props {
  city: CityMapState;
  defs: CityLayerDef[];
  onClose: () => void;
}

export function CityMap({ city, defs, onClose }: Props) {
  const [preset, setPreset] = useState<PresetId>('city');
  const [picked, setPicked] = useState<CityPick | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => loadEnabledCity(defs));
  const z = PRESETS.find((p) => p.id === preset)!.z;
  const home = city.home!;
  const homeLabel = city.label.replace(/^near\s+/i, '').split(',')[0] || 'home';

  const toggle = (id: string) => {
    setEnabled((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveEnabledCity(next);
      return next;
    });
    setPicked(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Viewport centered on home.
  const center = worldXY(home.lat, home.lon, z);
  const view: MercatorView = {
    z,
    originX: center.x * TILE - MAP_W / 2,
    originY: center.y * TILE - MAP_H / 2,
    w: MAP_W,
    h: MAP_H,
  };

  // Basemap tile grid (same helper the radar overlay uses).
  const tiles = useMemo(
    () => tileGrid(view),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [z, view.originX, view.originY],
  );

  // Layer states, resolved once per render.
  const states = defs.map((def) => {
    const data = city.data[def.id] ?? null;
    const isOn = enabled[def.id] ?? def.defaultOn;
    const hasArr = Array.isArray(data) || (data !== null && data !== 'unavailable');
    const content = hasArr && def.hasContent ? def.hasContent(data as never) : hasArr;
    return { def, data, isOn, rendering: isOn && content, chipVisible: isOn && (def.hasContent ? content : true) };
  });

  const bothLoading = states.filter((s) => s.isOn).every((s) => s.data === null);

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // width:100% + viewBox scales the svg below MAP_W on narrow viewports;
    // divide out the scale or clicks silently miss right/bottom targets.
    const scale = rect.width / MAP_W || 1;
    const mx = (e.clientX - rect.left) / scale;
    const my = (e.clientY - rect.top) / scale;
    let best: CityPick | null = null;
    let bestD = 10;
    for (const s of states) {
      if (!s.rendering || !s.def.pickables || s.data === null || s.data === 'unavailable') continue;
      for (const p of s.def.pickables(s.data as never, view)) {
        const dist = Math.hypot(p.x - mx, p.y - my);
        if (dist < bestD) { bestD = dist; best = { layerId: s.def.id, item: p.item, x: p.x, y: p.y }; }
      }
    }
    setPicked(best);
  };

  const chipCount = (s: (typeof states)[number]) =>
    s.data === null ? '…' : s.data === 'unavailable' ? '—' : (s.def.count?.(s.data as never) ?? '');

  const pickedDef = picked ? defs.find((d) => d.id === picked.layerId) : null;
  const pickedData = picked ? city.data[picked.layerId] : null;

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 50 }} />
      <div
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: `min(92vw, ${MAP_W + 28}px)`, zIndex: 51,
          font: `11px/1.6 ${mono}`, color: 'rgba(200,214,229,0.92)',
          background: 'rgba(6,10,16,0.97)', border: '1px solid rgba(79,216,255,0.3)',
          borderRadius: 5, padding: '10px 14px 8px', boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
        }}
      >
        {/* header: title · layer chips · ⊞ drawer · zoom presets · close */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>CITY</span>
          <span style={{ opacity: 0.7 }}>near {homeLabel}</span>
          {states.filter((s) => s.chipVisible).map((s) => (
            <span
              key={s.def.id}
              onClick={() => toggle(s.def.id)}
              title={s.def.describe}
              style={{
                cursor: 'pointer', padding: '1px 7px', borderRadius: 3, fontSize: 10,
                border: `1px solid ${s.rendering ? 'rgba(191,232,245,0.4)' : 'rgba(143,163,184,0.25)'}`,
                color: s.rendering ? s.def.chipColor : DIM,
              }}
            >
              {s.def.label} {chipCount(s)}
            </span>
          ))}
          <span
            onClick={() => setDrawer((v) => !v)}
            title="All city layers"
            style={{
              cursor: 'pointer', padding: '1px 7px', borderRadius: 3, fontSize: 10,
              border: `1px solid ${drawer ? 'rgba(79,216,255,0.5)' : 'rgba(79,216,255,0.18)'}`,
              color: drawer ? CYAN : DIM,
            }}
          >
            ⊞
          </span>
          <span style={{ flex: 1 }} />
          {PRESETS.map((p) => (
            <span
              key={p.id}
              onClick={() => { setPreset(p.id); setPicked(null); }}
              style={{
                cursor: 'pointer', padding: '1px 7px', borderRadius: 3, fontSize: 10,
                border: `1px solid ${preset === p.id ? 'rgba(79,216,255,0.5)' : 'rgba(79,216,255,0.18)'}`,
                color: preset === p.id ? CYAN : DIM,
              }}
            >
              {p.label}
            </span>
          ))}
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6, marginLeft: 4 }}>✕</span>
        </div>

        {/* drawer: every layer, toggle + description */}
        {drawer && (
          <div style={{ marginBottom: 8, padding: '6px 8px', border: '1px solid rgba(79,216,255,0.18)', borderRadius: 3 }}>
            {states.map((s) => (
              <div
                key={s.def.id}
                onClick={() => toggle(s.def.id)}
                style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', opacity: s.isOn ? 1 : 0.5 }}
              >
                <span style={{ color: s.isOn ? s.def.chipColor : DIM }}>{s.isOn ? '◉' : '○'}</span>
                <span style={{ minWidth: 74 }}>{s.def.label}</span>
                <span style={{ opacity: 0.55, fontSize: 10 }}>{s.def.describe}</span>
                <span style={{ flex: 1 }} />
                <span style={{ opacity: 0.5, fontSize: 10 }}>{chipCount(s)}</span>
              </div>
            ))}
          </div>
        )}

        {/* map */}
        <div
          style={{
            position: 'relative', width: '100%', maxWidth: MAP_W, height: MAP_H,
            margin: '0 auto', overflow: 'hidden', borderRadius: 3, background: '#0a0f16',
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
                position: 'absolute', left: t.left, top: t.top,
                // Inverting OSM turns white roads black — brightness/contrast UP
                // or the street network disappears (#114, verified in-browser).
                filter: 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(1.15) contrast(1.3)',
                userSelect: 'none', pointerEvents: 'none',
              }}
            />
          ))}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(6,10,16,0.12)', pointerEvents: 'none' }} />
          {/* field layers (radar) under the vector SVG */}
          {states.map((s) =>
            s.rendering && s.def.renderUnder && s.data !== null && s.data !== 'unavailable' ? (
              <div key={`u-${s.def.id}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {s.def.renderUnder(s.data as never, view)}
              </div>
            ) : null,
          )}
          {bothLoading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(200,214,229,0.7)', pointerEvents: 'none' }}>
              loading city data…
            </div>
          )}
          <svg
            width="100%"
            height={MAP_H}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
            onClick={pick}
          >
            {states.map((s) =>
              s.rendering && s.def.renderSvg && s.data !== null && s.data !== 'unavailable' ? (
                <g key={s.def.id}>{s.def.renderSvg(s.data as never, view, picked)}</g>
              ) : null,
            )}
            {/* home marker — amber ringed dot, matching the overhead radar */}
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
          <div
            style={{
              position: 'absolute', right: 4, bottom: 2, fontSize: 9,
              color: 'rgba(200,214,229,0.55)', textShadow: '0 1px 2px rgba(0,0,0,0.9)', pointerEvents: 'none',
            }}
          >
            map © OpenStreetMap contributors
          </div>
        </div>

        {/* legend row */}
        <div style={{ display: 'flex', gap: 12, marginTop: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {states.map((s) =>
            s.rendering && s.def.legend && s.data !== null && s.data !== 'unavailable' ? (
              <span key={s.def.id}>{s.def.legend(s.data as never)}</span>
            ) : s.isOn && s.data === 'unavailable' && !s.def.hasContent ? (
              <span key={s.def.id} style={{ fontSize: 10, opacity: 0.5 }}>{s.def.label.toLowerCase()} unavailable</span>
            ) : null,
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, opacity: 0.45 }}>
            {states.filter((s) => s.rendering && s.def.attribution).map((s) => s.def.attribution).join(' · ')}
          </span>
        </div>

        {/* detail strip */}
        <div style={{ minHeight: 18, marginTop: 2 }}>
          {picked && pickedDef?.detail && pickedData !== null && pickedData !== 'unavailable' ? (
            pickedDef.detail(picked.item, pickedData as never)
          ) : (
            <span style={{ opacity: 0.4 }}>click a dot for details</span>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
