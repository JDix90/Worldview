/**
 * The CITY view (#113 crime → #122 cameras → #125 layer framework → #127
 * full-viewport pan/zoom): a hand-rolled OSM tile mosaic with N data layers,
 * each a CityLayerDef (city/registry.ts). This file is deliberately a thin
 * orchestrator — mosaic, chrome, drawer, pick dispatch, detail strip — and
 * knows nothing about any specific layer.
 *
 * #127 turned it from a 656×400 modal with two zoom presets into a view that
 * takes over the viewport like the globe does: drag to pan, pinch/wheel/
 * double-tap to zoom continuously, tap to select. All of the gesture work
 * lives in useMapGesture; what this file owns is the split that keeps it fast:
 * the layers re-project only from `core` (committed React state), while the
 * gesture moves a CSS transform on the pane. Nothing here runs per-frame.
 *
 * Chip grammar (the accretion guardrail): a chip renders only when its layer
 * is enabled AND has content (exception-based layers vanish when empty); the
 * trailing ⊞ chip opens a drawer listing every layer with toggles. Tiles
 * dimmed/inverted; © OSM attribution per tile policy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TILE,
  toPx,
  fromPx,
  scaledTileGrid,
  fitZoom,
  viewCenteredOn,
  DATA_FOOTPRINT_DEG,
  type CityLayerDef,
  type CityPick,
  type MercatorView,
} from '../city/registry';
import { useMapGesture, metersPerPx, type ViewCore } from '../city/useMapGesture';
import { Chip } from './Chip';
import { mono, C, pressable } from './uiKit';
import type { CityMapState } from '../feed/useCityMap';

// Instrument tokens now live in uiKit (#133); these are the local aliases the
// file already read by name.
const CYAN = C.cyan;
const DIM = C.dim;
const PANEL = C.panel;
const EDGE = `1px solid ${C.edge}`;
const HINT_KEY = 'orrery:citymap:picked-once';

/** z9 ≈ the whole Front Range; z17 ≈ individual buildings. Below z8 the radar
 *  layer's tile addressing stops being integer, and nothing here is a globe. */
const MIN_Z = 9;
const MAX_Z = 17;
/** OSM publishes to z19; never ask for a level that doesn't exist. */
const MAX_TILE_Z = 19;
/** Phones get stacked chrome and bigger targets. */
const NARROW = 640;

interface Props {
  city: CityMapState;
  defs: CityLayerDef[];
  onClose: () => void;
}

function useViewportSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return size;
}

export function CityMap({ city, defs, onClose }: Props) {
  const size = useViewportSize();
  const home = city.home!;
  const homeLabel = city.label.replace(/^near\s+/i, '').split(',')[0] || 'home';
  const narrow = size.w < NARROW;

  const [picked, setPicked] = useState<CityPick | null>(null);
  // Layer enabled-state is owned by useCityMap now (#132), shared with the
  // bottom-right CITY LAYERS panel so toggling is consistent with the globe.
  const enabled = city.enabled;

  // The "tap an icon for details" hint retires permanently after the first
  // successful pick (#133) — a returning user has learned the map.
  const [pickedOnce, setPickedOnce] = useState(() => {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
  });

  // The zoom that frames the data footprint in a w×h viewport, guarded against
  // a 0/tiny size at first paint (fitZoom → NaN/−∞) so the opening view is
  // never a degenerate clamp.
  const fitCore = (w: number, h: number): ViewCore => {
    const raw = fitZoom(home, w, h);
    const z = Number.isFinite(raw) ? Math.min(MAX_Z, Math.max(MIN_Z, raw)) : 12;
    const v = viewCenteredOn(home, z, Math.max(1, w), Math.max(1, h));
    return { z: v.z, originX: v.originX, originY: v.originY };
  };

  // The committed view: what every layer is projected with. The gesture engine
  // moves a transform and hands back a new core only when it settles.
  const [core, setCore] = useState<ViewCore>(() => fitCore(window.innerWidth, window.innerHeight));
  const view: MercatorView = { ...core, w: size.w, h: size.h };

  // Any user pan/zoom flips this: after it, resize preserves their view; before
  // it, resize re-fits. That also self-heals a first paint that measured the
  // viewport before it had settled (the opening zoom then lands once size does).
  const interacted = useRef(false);
  const commitCore = (v: ViewCore) => {
    interacted.current = true;
    setCore(v);
  };

  const lastSize = useRef(size);
  useEffect(() => {
    const prev = lastSize.current;
    if (prev.w === size.w && prev.h === size.h) return;
    lastSize.current = size;
    if (!interacted.current) {
      setCore(fitCore(size.w, size.h)); // re-fit home until the user takes over
    } else {
      // keep the geographic centre put rather than the top-left corner
      setCore((c) => ({
        ...c,
        originX: c.originX + (prev.w - size.w) / 2,
        originY: c.originY + (prev.h - size.h) / 2,
      }));
    }
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Two-phase paint (#126): the first commit renders chrome + basemap only, so
  // the view appears the instant you click; the ~900-1500 layer SVG nodes mount
  // one frame later. Initial mount ONLY — a pan/zoom commit is a cheap update,
  // not a re-mount, so re-arming it would flash the map on every gesture.
  // rAF is raced with a timeout because a hidden tab never fires rAF at all,
  // which would otherwise leave the map stuck at "drawing…" forever.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setPainted(true);
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(go));
    const timer = window.setTimeout(go, 50);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  const toggle = (id: string) => {
    city.toggle(id);
    setPicked(null);
  };

  // If the picked item's layer is turned off (from either toggle surface), drop
  // the selection so a card can't outlive the layer that owns it.
  useEffect(() => {
    if (picked && !(enabled[picked.layerId] ?? defs.find((d) => d.id === picked.layerId)?.defaultOn)) {
      setPicked(null);
    }
  }, [enabled, picked, defs]);

  // Escape dismisses a selection first, then (pressed again) the whole view —
  // otherwise dismissing a detail card means leaving the map entirely.
  const pickedRef = useRef<CityPick | null>(picked);
  pickedRef.current = picked;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickedRef.current) setPicked(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A full-viewport map that swallows drags must also stop the page bouncing
  // under them (pull-to-refresh, rubber-band) while it is open.
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overscrollBehavior = prev;
    };
  }, []);

  // Layer states, resolved once per render.
  const states = defs.map((def) => {
    const data = city.data[def.id] ?? null;
    const isOn = enabled[def.id] ?? def.defaultOn;
    const hasArr = Array.isArray(data) || (data !== null && data !== 'unavailable');
    const content = hasArr && def.hasContent ? def.hasContent(data as never) : hasArr;
    return { def, data, isOn, rendering: isOn && content, chipVisible: isOn && (def.hasContent ? content : true) };
  });
  const statesRef = useRef(states);
  statesRef.current = states;

  const allLoading = states.filter((s) => s.isOn).every((s) => s.data === null);

  // Tap → pick. The gesture engine hands over the LIVE view, because a tap can
  // land while an animation is still uncommitted; picking against committed
  // state would then miss by however far the map had travelled.
  const pick = (x: number, y: number, touch: boolean, live: ViewCore) => {
    const v: MercatorView = { ...live, w: size.w, h: size.h };
    // A fingertip is not a cursor: the 10px radius tuned for a mouse (#125) is
    // well under a touch target, so touch gets a fingertip-sized one.
    let bestD = touch ? 22 : 10;
    let best: CityPick | null = null;
    for (const s of statesRef.current) {
      if (!s.rendering || !s.def.pickables || s.data === null || s.data === 'unavailable') continue;
      for (const p of s.def.pickables(s.data as never, v)) {
        const dist = Math.hypot(p.x - x, p.y - y);
        if (dist < bestD) {
          bestD = dist;
          const geo = fromPx(v, p.x, p.y);
          best = { layerId: s.def.id, item: p.item, x: p.x, y: p.y, lat: geo.lat, lon: geo.lon };
        }
      }
    }
    setPicked(best);
    if (best && !pickedOnce) {
      setPickedOnce(true);
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ }
    }
  };

  // Flat clickable-point index for the hover cursor. Rebuilt only when the
  // committed view or data changes — NOT per mouse-move — so hovering a
  // 2700-point map costs a handful of distance checks, not a re-projection.
  const pickIndex = useMemo(() => {
    const out: Array<{ x: number; y: number }> = [];
    for (const s of states) {
      if (!s.rendering || !s.def.pickables || s.data === null || s.data === 'unavailable') continue;
      for (const p of s.def.pickables(s.data as never, view)) out.push({ x: p.x, y: p.y });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.data, enabled, core.z, core.originX, core.originY, size.w, size.h]);

  const onHoverTest = useCallback(
    (x: number, y: number) => {
      for (const p of pickIndex) if (Math.hypot(p.x - x, p.y - y) < 10) return true;
      return false;
    },
    [pickIndex],
  );

  const { surfaceRef, paneRef, animateTo, zoomAboutCentre } = useMapGesture({
    view,
    minZ: MIN_Z,
    maxZ: MAX_Z,
    onCommit: commitCore,
    onTap: pick,
    onHoverTest,
    enabled: true,
  });

  const recenter = () => {
    interacted.current = true;
    animateTo(fitCore(size.w, size.h), 320);
  };

  // Basemap: real tile servers only speak integer zoom, so the nearest level is
  // fetched and CSS-scaled to the continuous view. One tile of padding means a
  // drag can translate the pane without exposing empty edges.
  const tileZ = Math.max(1, Math.min(MAX_TILE_Z, Math.round(core.z)));
  const tiles = useMemo(
    () => scaledTileGrid(view, tileZ, 1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [core.z, core.originX, core.originY, size.w, size.h, tileZ],
  );

  // Level-crossing without the blank flash: when tileZ changes, every <img>
  // key changes and the whole basemap refetches — until those arrive the map
  // would be a void, which reads as a jump mid-pinch. So the PREVIOUS level
  // stays rendered underneath (scaledTileGrid projects any integer level onto
  // the same view) until the new level reports loaded, or a timeout gives up.
  const [underZ, setUnderZ] = useState<number | null>(null);
  const prevTileZ = useRef(tileZ);
  const tilesLoaded = useRef(0);
  useEffect(() => {
    if (prevTileZ.current === tileZ) return;
    setUnderZ(prevTileZ.current);
    prevTileZ.current = tileZ;
    tilesLoaded.current = 0;
    const t = window.setTimeout(() => setUnderZ(null), 1500); // slow tiles: don't hold two levels forever
    return () => clearTimeout(t);
  }, [tileZ]);
  const tileSettled = () => {
    tilesLoaded.current += 1;
    if (tilesLoaded.current >= tiles.length) setUnderZ(null);
  };
  const underTiles = underZ !== null ? scaledTileGrid(view, underZ, 1) : [];

  const homePx = toPx(view, home.lat, home.lon);
  // The honest edge: CRIME and CAMERAS were only ever fetched inside this box.
  const fpA = toPx(view, home.lat + DATA_FOOTPRINT_DEG.lat, home.lon - DATA_FOOTPRINT_DEG.lon);
  const fpB = toPx(view, home.lat - DATA_FOOTPRINT_DEG.lat, home.lon + DATA_FOOTPRINT_DEG.lon);
  const footprintVisible = fpA.x > 0 || fpA.y > 0 || fpB.x < size.w || fpB.y < size.h;

  const chipCount = (s: (typeof states)[number]) =>
    s.data === null ? '…' : s.data === 'unavailable' ? '—' : (s.def.count?.(s.data as never) ?? '');

  const pickedDef = picked ? defs.find((d) => d.id === picked.layerId) : null;
  const pickedData = picked ? city.data[picked.layerId] : null;
  const pickedReady = !!(picked && pickedDef && pickedData !== null && pickedData !== 'unavailable');
  const detailCard =
    pickedReady && pickedDef!.detailCard ? pickedDef!.detailCard(picked!.item, pickedData as never) : null;
  const showCard = pickedReady && !!(detailCard || pickedDef!.detail);

  // Re-pick a sibling item (the card's stacked pager). Re-projects it through
  // the current view so the selection halo lands on the right dot.
  const pickItem = (item: unknown) => {
    if (!picked || !pickedDef?.pickables || pickedData === null || pickedData === 'unavailable') return;
    const p = pickedDef.pickables(pickedData as never, view).find((q) => q.item === item);
    if (!p) return;
    const geo = fromPx(view, p.x, p.y);
    setPicked({ layerId: picked.layerId, item, x: p.x, y: p.y, lat: geo.lat, lon: geo.lon });
  };

  // ── chrome pieces ────────────────────────────────────────────────────────
  const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
    cursor: 'pointer',
    padding: narrow ? '7px 11px' : '3px 8px',
    borderRadius: 3,
    fontSize: narrow ? 12 : 10,
    border: EDGE,
    background: PANEL,
    color: DIM,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    ...extra,
  });

  const layerChips = states
    .filter((s) => s.chipVisible)
    .map((s) => (
      <Chip
        key={s.def.id}
        variant="compact"
        size={narrow ? 'lg' : 'sm'}
        label={s.def.label}
        count={chipCount(s)}
        accent={s.def.chipColor}
        active={s.rendering}
        loading={s.data === null}
        title={s.def.describe}
        onClick={() => toggle(s.def.id)}
      />
    ));

  const scale = (() => {
    const mpp = metersPerPx(view, home.lat);
    const targets = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
    const meters = targets.find((m) => m / mpp > 60) ?? 50_000;
    return { px: Math.round(meters / mpp), label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m` };
  })();

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: '#0a0f16', font: `11px/1.6 ${mono}`, color: 'rgba(200,214,229,0.92)' }}>
      {/* gesture surface — everything geographic lives inside it */}
      <div
        ref={surfaceRef}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          // cursor is owned by the gesture hook (grab · grabbing · pointer over
          // a clickable icon), so it isn't hard-set here.
          // Without this the browser claims the gesture first: a one-finger
          // drag scrolls the page and two fingers zoom the document.
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        {/* the transformed pane: moved by CSS during a gesture, re-projected
            only when the gesture settles. pointerEvents:none so every event
            lands on the surface and no <img> starts a native drag. */}
        <div ref={paneRef} style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', willChange: 'transform', pointerEvents: 'none' }}>
          {/* outgoing tile level — stays under the incoming one until it loads */}
          {underTiles.map((t) => (
            <img
              key={`u${underZ}/${t.x}/${t.y}`}
              src={`https://tile.openstreetmap.org/${underZ}/${t.x}/${t.y}.png`}
              width={t.size}
              height={t.size}
              alt=""
              referrerPolicy="no-referrer"
              draggable={false}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
              style={{
                position: 'absolute',
                left: t.left,
                top: t.top,
                filter: 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(1.15) contrast(1.3)',
                userSelect: 'none',
              }}
            />
          ))}
          {tiles.map((t) => (
            <img
              key={`${tileZ}/${t.x}/${t.y}`}
              src={`https://tile.openstreetmap.org/${tileZ}/${t.x}/${t.y}.png`}
              width={t.size}
              height={t.size}
              alt=""
              // NOT lazy: the padding ring exists to be ready before a drag
              // reveals it, and lazy loading would defer exactly those tiles.
              referrerPolicy="no-referrer"
              draggable={false}
              onLoad={tileSettled}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                tileSettled();
              }}
              style={{
                position: 'absolute',
                left: t.left,
                top: t.top,
                // Inverting OSM turns white roads black — brightness/contrast UP
                // or the street network disappears (#114, verified in-browser).
                filter: 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(1.15) contrast(1.3)',
                userSelect: 'none',
              }}
            />
          ))}
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(6,10,16,0.12)' }} />
          {/* field layers (radar) under the vector SVG */}
          {painted &&
            states.map((s) =>
              s.rendering && s.def.renderUnder && s.data !== null && s.data !== 'unavailable' ? (
                <div key={`u-${s.def.id}`} style={{ position: 'absolute', inset: 0 }}>
                  {s.def.renderUnder(s.data as never, view)}
                </div>
              ) : null,
            )}
          <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            {footprintVisible && (
              <rect
                x={fpA.x}
                y={fpA.y}
                width={Math.max(0, fpB.x - fpA.x)}
                height={Math.max(0, fpB.y - fpA.y)}
                fill="none"
                stroke="rgba(143,163,184,0.35)"
                strokeWidth={1}
                strokeDasharray="5 5"
              />
            )}
            {painted &&
              states.map((s) =>
                s.rendering && s.def.renderSvg && s.data !== null && s.data !== 'unavailable' ? (
                  <g key={s.def.id}>{s.def.renderSvg(s.data as never, view, picked)}</g>
                ) : null,
              )}
            {/* selection halo — a pulsing accent ring so the picked icon reads
                instantly on a crowded map. Anchored in geography (fromPx at
                click), so it re-projects and follows pan/zoom. */}
            {picked?.lat !== undefined &&
              picked.lon !== undefined &&
              (() => {
                const sp = toPx(view, picked.lat, picked.lon);
                const col = pickedDef?.chipColor ?? CYAN;
                return (
                  <g style={{ pointerEvents: 'none' }}>
                    <circle cx={sp.x} cy={sp.y} r={11} fill="none" stroke={col} strokeWidth={1.6} opacity={0.95} />
                    <circle cx={sp.x} cy={sp.y} r={9} fill="none" stroke={col} strokeWidth={1.4}>
                      <animate attributeName="r" values="9;22" dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                  </g>
                );
              })()}
            {/* home marker — amber ringed dot, matching the overhead radar. A
                geographic point now that the map moves, not the box's centre. */}
            <circle cx={homePx.x} cy={homePx.y} r={5} fill="none" stroke="#ffd27f" strokeWidth={1.4} />
            <circle cx={homePx.x} cy={homePx.y} r={1.8} fill="#ffd27f" />
            <text
              x={homePx.x}
              y={homePx.y + 15}
              fontSize={9}
              fill="#ffd27f"
              textAnchor="middle"
              fontFamily={mono}
              style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.8)', strokeWidth: 2 }}
            >
              {homeLabel}
            </text>
          </svg>
        </div>

        {(!painted || allLoading) && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(200,214,229,0.7)', pointerEvents: 'none' }}>
            {allLoading ? 'loading city data…' : 'drawing…'}
          </div>
        )}
      </div>

      {/* ── top bar: STATUS, not navigation (#132) ──────────────────────────
          Title + the active-layer chips (which still quick-toggle). Exit and
          the full layer list now live in the bottom-right cluster, exactly
          where the globe keeps its controls — so leaving CITY happens in the
          same corner you entered it. Mirrors the globe's top-left HUD readout. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: narrow ? 'column' : 'row',
          alignItems: narrow ? 'stretch' : 'center',
          gap: narrow ? 6 : 8,
          padding: narrow ? '8px 8px 12px' : '8px 12px 20px',
          background: 'linear-gradient(rgba(6,10,16,0.95), rgba(6,10,16,0))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
          <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>CITY</span>
          <span style={{ opacity: 0.7 }}>near {homeLabel}</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}
        >
          {layerChips}
        </div>
      </div>

      {/* ── map controls: right edge, clear of the bottom-right cluster and the
          bottom-left detail card (#132). No hover required. ────────────────── */}
      <div
        style={{
          position: 'absolute',
          right: narrow ? 8 : 12,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'stretch',
          textAlign: 'center',
        }}
      >
        <span className="orx-chip" {...pressable(recenter)} aria-label="Recenter on home" title="Recenter on home" style={btn({ padding: narrow ? '10px 12px' : '6px 10px', fontSize: narrow ? 15 : 13 })}>
          ⌂
        </span>
        <span className="orx-chip" {...pressable(() => zoomAboutCentre(1, size.w, size.h))} aria-label="Zoom in" title="Zoom in" style={btn({ padding: narrow ? '10px 12px' : '6px 10px', fontSize: narrow ? 15 : 13 })}>
          +
        </span>
        <span className="orx-chip" {...pressable(() => zoomAboutCentre(-1, size.w, size.h))} aria-label="Zoom out" title="Zoom out" style={btn({ padding: narrow ? '10px 12px' : '6px 10px', fontSize: narrow ? 15 : 13 })}>
          −
        </span>
      </div>

      {/* First-run hint — a small centred pill that retires forever after the
          first pick (#133). Held above the thin bottom strip; never over a card. */}
      {!pickedOnce && !showCard && painted && !allLoading && (
        <div
          style={{
            position: 'absolute',
            bottom: narrow ? 42 : 34,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 12px',
            borderRadius: 999,
            border: EDGE,
            background: 'rgba(6,10,16,0.82)',
            fontSize: narrow ? 12 : 11,
            opacity: 0.85,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {narrow ? 'tap an icon for details' : 'click an icon for details'}
        </div>
      )}

      {/* ── bottom strip: scale · zoom · data footprint · attribution ────────
          Dieted from the old three-row bar (#133): per-layer legend/freshness
          moved into the CITY LAYERS drawer, counts live on the chips, so what's
          left is one honest line of map metadata. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: narrow ? '10px 10px 8px' : '12px 12px 7px',
          background: 'linear-gradient(rgba(6,10,16,0), rgba(6,10,16,0.92) 55%)',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9, opacity: 0.6 }}>
          <span style={{ display: 'inline-block', width: scale.px, height: 4, borderLeft: '1px solid currentColor', borderRight: '1px solid currentColor', borderBottom: '1px solid currentColor' }} />
          {scale.label}
        </span>
        <span style={{ fontSize: 9, opacity: 0.45 }}>z{core.z.toFixed(1)}</span>
        {footprintVisible && (
          <span title="Crime & cameras were only fetched within ±8 mi of home — nothing beyond this box was ever queried." style={{ fontSize: 9, opacity: 0.55, cursor: 'help', whiteSpace: 'nowrap' }}>
            ⌐ ±8 mi data ⓘ
          </span>
        )}
        <span style={{ flex: 1, minWidth: 8 }} />
        <span style={{ fontSize: 9, opacity: 0.45, textAlign: 'right' }}>
          map © OpenStreetMap contributors
          {states.filter((s) => s.rendering && s.def.attribution).length > 0 && ' · '}
          {states
            .filter((s) => s.rendering && s.def.attribution)
            .map((s) => s.def.attribution)
            .join(' · ')}
        </span>
      </div>

      {/* ── picked-item detail card ─────────────────────────────────────────
          The detail used to be a thin line sharing the bottom gradient with the
          legend, over a busy basemap — easy to miss (owner feedback). Now a
          distinct elevated card: opaque background, the layer's accent colour on
          the border + header, and a ✕. Desktop floats bottom-left above the
          bottom bar; mobile is a full-width bottom sheet. The map's pulsing halo
          ties it back to the icon you clicked. */}
      {showCard &&
        (() => {
          const accent = pickedDef!.chipColor;
          const related = detailCard?.related;
          const idx = related ? related.indexOf(picked!.item) : -1;
          const step = (dir: number) => related && idx >= 0 && pickItem(related[(idx + dir + related.length) % related.length]);
          const labelSize = narrow ? 12 : 11;
          return (
            <div
              style={{
                position: 'absolute',
                // Mobile: sit bottom-left and STOP short of the bottom-right
                // cluster (a full-width sheet would slide under it, #133).
                ...(narrow
                  ? { left: 8, right: 150, bottom: 8 }
                  : { left: 12, bottom: 84, width: 'min(440px, calc(100vw - 24px))' }),
                zIndex: 5,
                background: 'rgba(9,14,20,0.98)',
                border: `1px solid ${accent}`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: 5,
                boxShadow: '0 8px 34px rgba(0,0,0,0.72)',
                padding: narrow ? '10px 12px 12px' : '9px 12px 11px',
              }}
            >
              {/* header: accent dot · LAYER (· kicker) · stacked pager · ✕ */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: detailCard ? 7 : 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, boxShadow: `0 0 6px ${accent}`, flexShrink: 0 }} />
                <span style={{ color: accent, fontWeight: 600, letterSpacing: 1.2, fontSize: labelSize }}>
                  {detailCard?.kicker ?? pickedDef!.label}
                </span>
                <span style={{ flex: 1 }} />
                {related && idx >= 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: labelSize, opacity: 0.8 }}>
                    <span className="orx-x" {...pressable(() => step(-1))} title="Previous at this block" style={{ cursor: 'pointer', padding: '0 3px' }}>‹</span>
                    <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{idx + 1}/{related.length}</span>
                    <span className="orx-x" {...pressable(() => step(1))} title="Next at this block" style={{ cursor: 'pointer', padding: '0 3px' }}>›</span>
                  </span>
                )}
                <span
                  className="orx-x"
                  {...pressable(() => setPicked(null))}
                  aria-label="Dismiss"
                  title="Dismiss (Esc)"
                  style={{ cursor: 'pointer', color: DIM, fontSize: narrow ? 16 : 13, lineHeight: 1, padding: narrow ? '2px 6px' : '0 4px' }}
                >
                  ✕
                </span>
              </div>

              {detailCard ? (
                <>
                  <div style={{ fontSize: narrow ? 15 : 13, fontWeight: 600, color: '#eaf1f8', marginBottom: 6, lineHeight: 1.3 }}>
                    {detailCard.title}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 3, fontSize: narrow ? 13 : 12, lineHeight: 1.5 }}>
                    {detailCard.rows.map((r, i) => (
                      <div key={i} style={{ display: 'contents' }}>
                        <span style={{ opacity: 0.5, whiteSpace: 'nowrap' }}>{r.label}</span>
                        <span style={{ color: 'rgba(214,226,238,0.96)' }}>{r.value}</span>
                      </div>
                    ))}
                  </div>
                  {detailCard.action && (
                    <div
                      className="orx-x"
                      {...pressable(detailCard.action.onClick)}
                      title={detailCard.action.title}
                      style={{ cursor: 'pointer', color: CYAN, marginTop: 8, fontSize: narrow ? 13 : 12 }}
                    >
                      {detailCard.action.label}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: narrow ? 13 : 12, lineHeight: 1.55, color: 'rgba(214,226,238,0.96)' }}>
                  {pickedDef!.detail!(picked!.item, pickedData as never)}
                </div>
              )}
            </div>
          );
        })()}
    </div>,
    document.body,
  );
}
