# CITY map → full-viewport interactive view (pan / zoom / pinch)
**2026-07-23 · owner-ratified · implemented in DECISIONS #127**

## Context

The CITY map was a `position:fixed`, 656×400 modal with two fixed zoom presets (z11 / z13),
portaled over the globe ([CityMap.tsx](../../apps/web/src/ui/CityMap.tsx)). Eight live layers now
render into it (#125, #126) and the box is the limiting factor: z11 can't see the metro, z13 can't
move, and on a phone it's a postage stamp. This makes CITY a real view — it takes over the viewport
like the globe, with drag-to-pan, continuous zoom, touch as a first-class input, and a return path.

**Owner decisions:** full takeover with a `‹ GLOBE` bar · inertial glide · hand-rolled Pointer Events
(no new dependency) · responsive top/bottom chrome bars.

## Verified before building (measurement, not assumption)

- **The 8 layer files need zero changes.** Every layer projects through `toPx(view,lat,lon)` and
  `worldXY` uses `2**z`, correct for fractional z. Only `radarLayer` is touched — to *delete* code.
- **Re-projecting per frame is unusable; transforming is free.** Live-app measurement, React 18.3.1,
  2700 circles (crime+cameras+311 worst case): React re-render **35–43 ms**; CSS transform **0.1 ms**;
  React mount 57 ms one-time. → the gesture path does no React work.
- **Panning outruns the data.** Crime/cameras fetch a **±8 mi** box ([crime.ts](../../apps/web/src/feed/crime.ts),
  [alpr.ts](../../apps/web/src/feed/alpr.ts)); a full-viewport z11 map spans ~47 mi. Handled by a
  fit-to-footprint opening zoom + an honest dashed edge, not by re-fetching.
- `pauseAnimation()`/`resumeAnimation()` exist on react-globe.gl 2.38 → globe stays mounted, paused.

## Design

- **`useMapGesture.ts`** — one Pointer Events pipeline. 1 pointer = pan, 2 = pan+pinch (centroid +
  spread). `touch-action:none`, non-passive native wheel, inertial glide, 22 px touch pick radius.
- **Two-view split** — `committedView` (React state, layers project from it) vs `liveView` (a ref the
  gesture moves); the pane transform is exactly their difference, so committing shows no seam. Commit
  on settle / >192 px pan / >0.5-level pinch.
- **Continuous zoom** — `registry.ts` gains `scaledTileGrid(view, tileZ)` (the fractional-tile math
  radar hand-rolled, lifted); basemap + radar share it; `fitZoom`/`viewCenteredOn`/`DATA_FOOTPRINT_DEG`
  give a device-independent opening zoom and the shared ±8 mi constant.
- **Layout** — full-bleed map; floating top bar (`‹ GLOBE` · title · chips · ⊞ · zoom) and bottom bar
  (detail · legend · scale · attribution); phone → stacked bars, scrollable chip row, bottom sheets.
- **Takeover** — `App` hides the chip cluster and passes `paused` to `GlobeView` (pause render + skip
  layer tick + hidden); WS feed / HUD / `useLoiterWatch` keep running; **no globe tuning touched**.

## Files

`city/useMapGesture.ts` (new) · `city/registry.ts` · `ui/CityMap.tsx` · `App.tsx` · `globe/GlobeView.tsx`
(additive `paused`) · `city/layers/radarLayer.tsx` (delete inline loop) · `feed/crime.ts` + `feed/alpr.ts`
(import shared footprint) · `ui/HomeDashboard.tsx` (open-city closes the panel). `useCityMap.ts`
unchanged. Client-only; no server/worker/Pi changes.

## Verification

In-preview (structure/math): pan exact, wheel zoom exact (anchor to 0.1 px), tap-select, all layers,
mobile bars/sheet at forced 390 px, return-to-globe, clean console. Hands-on (foreground window, since
automation reports the tab hidden → rAF frozen): inertia feel at 60 fps + a sustained-drag fps trace
with crime+cameras+311 on. **No deploy** — owner's call per #120.
