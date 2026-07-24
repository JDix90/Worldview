/**
 * CITY map layer framework (Round 1, DECISIONS #125). Mirrors the globe's
 * proven LayerDef registry (layers/registry.ts): each city layer is a small
 * self-contained definition — fetch, project, render, detail, legend — and
 * CityMap.tsx is a thin orchestrator. Built BEFORE round 1's six new layers
 * so the modal doesn't become the 2,000-line file the fresh-eyes review
 * warned about.
 *
 * Independence law (#122, generalized): every layer's data is fetched,
 * cached, and failed independently. One dead upstream dims one chip.
 */
import type { ReactNode } from 'react';

// ── Mercator plumbing (moved from CrimeMap; single source of truth) ───────
export const TILE = 256;

export interface MercatorView {
  z: number;
  /** World-pixel offset of the viewport's top-left. */
  originX: number;
  originY: number;
  w: number;
  h: number;
}

/** Web-Mercator: lon/lat → world coordinates in tile units at zoom z. */
export function worldXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Project lat/lon to viewport px under a view. */
export function toPx(view: MercatorView, lat: number, lon: number): { x: number; y: number } {
  const w = worldXY(lat, lon, view.z);
  return { x: w.x * TILE - view.originX, y: w.y * TILE - view.originY };
}

/** Inverse of toPx — viewport px back to lat/lon. Lets a picked point be
 *  stored as geography and re-projected as the map pans, instead of freezing
 *  at the pixel it was clicked (#129). */
export function fromPx(view: MercatorView, x: number, y: number): { lat: number; lon: number } {
  const n = 2 ** view.z;
  const worldX = (x + view.originX) / TILE;
  const worldY = (y + view.originY) / TILE;
  const lon = (worldX / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / n))) * 180) / Math.PI;
  return { lat, lon };
}

export function onScreen(view: MercatorView, p: { x: number; y: number }, pad = 4): boolean {
  return p.x >= -pad && p.x <= view.w + pad && p.y >= -pad && p.y <= view.h + pad;
}

export interface Tile {
  x: number;
  y: number;
  left: number;
  top: number;
  /** On-screen size in px — TILE only when tileZ === view.z. */
  size: number;
}

/**
 * XYZ tiles covering the viewport, addressed at an INTEGER `tileZ` that need
 * not equal `view.z`. Real tile servers only speak integer zoom, but the view
 * is continuous (#127), so a tile is drawn at `TILE * 2**(view.z - tileZ)` px
 * and the browser scales it — the standard slippy-map answer for the space
 * between levels, and the same trick radarLayer already hand-rolled to
 * over-zoom RainViewer's z7 ceiling (#125). Basemap and radar now share it,
 * so the two can't drift apart.
 *
 * `pad` extends the grid by whole tiles beyond the viewport, which is what
 * lets a drag translate the whole pane without exposing empty edges.
 */
export function scaledTileGrid(view: MercatorView, tileZ: number, pad = 0): Tile[] {
  const n = 2 ** tileZ;
  const size = TILE * 2 ** (view.z - tileZ); // one tile's on-screen px
  const out: Tile[] = [];
  const x0 = Math.floor(view.originX / size) - pad;
  const x1 = Math.floor((view.originX + view.w) / size) + pad;
  const y0 = Math.floor(view.originY / size) - pad;
  const y1 = Math.floor((view.originY + view.h) / size) + pad;
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue; // no wrap in latitude
      out.push({
        x: ((tx % n) + n) % n, // longitude wraps
        y: ty,
        left: tx * size - view.originX,
        top: ty * size - view.originY,
        size,
      });
    }
  }
  return out;
}

/** XYZ tiles at the view's own (integer) zoom. */
export function tileGrid(view: MercatorView): Tile[] {
  return scaledTileGrid(view, view.z);
}

// ── The data footprint ────────────────────────────────────────────────────
/**
 * Half-extent of the box CRIME and CAMERAS are fetched into — ~±8 mi at
 * Denver's latitude. Both fetchers (feed/crime.ts, feed/alpr.ts) import this,
 * so the number has one home; the map uses it to pick an opening zoom that
 * frames the data it actually has, and to draw the honest edge beyond which
 * nothing was ever fetched.
 */
export const DATA_FOOTPRINT_DEG = { lat: 0.12, lon: 0.15 } as const;

/**
 * The zoom at which the data footprint just fits a w×h viewport. Opening here
 * means a phone and a desktop show the same real-world area rather than the
 * same pixel count — a fixed z would frame ~47 mi of mostly-empty map on a
 * wide screen and a few blocks on a narrow one.
 */
export function fitZoom(home: { lat: number; lon: number }, w: number, h: number): number {
  const span = (z: number) => {
    const a = worldXY(home.lat - DATA_FOOTPRINT_DEG.lat, home.lon - DATA_FOOTPRINT_DEG.lon, z);
    const b = worldXY(home.lat + DATA_FOOTPRINT_DEG.lat, home.lon + DATA_FOOTPRINT_DEG.lon, z);
    return { w: Math.abs(b.x - a.x) * TILE, h: Math.abs(b.y - a.y) * TILE };
  };
  const s = span(0); // px at z0; every level doubles
  return Math.min(Math.log2(w / s.w), Math.log2(h / s.h));
}

/** A view of w×h px centered on a lat/lon at zoom z. */
export function viewCenteredOn(
  center: { lat: number; lon: number },
  z: number,
  w: number,
  h: number,
): MercatorView {
  const c = worldXY(center.lat, center.lon, z);
  return { z, originX: c.x * TILE - w / 2, originY: c.y * TILE - h / 2, w, h };
}

// ── Layer state ───────────────────────────────────────────────────────────
/** null = loading · 'unavailable' = upstream failed · T = data. */
export type LayerData<T> = T | 'unavailable' | null;

export interface CityPick {
  layerId: string;
  item: unknown;
  x: number;
  y: number;
  /** Pick point as geography, so the selection halo tracks across pan/zoom
   *  (x/y are frozen at click-time; lat/lon re-project). */
  lat?: number;
  lon?: number;
}

/** One label→value line in the detail card. */
export interface CityDetailRow {
  label: string;
  value: ReactNode;
}

/**
 * Structured detail for the picked-item card (#131). Richer than the one-line
 * `detail`: a kicker + title + labelled rows read like the globe's AircraftCard
 * instead of a run-on ` · ` sentence. `related` lets the card page through
 * siblings that stack on one spot (e.g. several crimes on the same block).
 */
export interface CityDetail {
  /** Small caps line above the title — usually the group/category. */
  kicker?: string;
  title: ReactNode;
  rows: CityDetailRow[];
  /** Bottom action (e.g. loiter's "⤓ fly"). */
  action?: { label: string; title?: string; onClick: () => void };
  /** Sibling items stacked at this spot, in display order (includes the picked
   *  one). The card shows a "n / N ‹ ›" pager and re-picks on step. */
  related?: unknown[];
}

export interface CityLayerDef<T = unknown> {
  id: string;
  /** Chip text, uppercase by convention. */
  label: string;
  chipColor: string;
  /** Initial enabled state (persisted per-id thereafter). */
  defaultOn: boolean;
  /** One-liner for the ⊞ drawer. */
  describe: string;
  attribution?: string;

  /** Fetch once at load (cheap; feeds chips + dashboard counts). */
  fetchEager?: (home: { lat: number; lon: number }) => Promise<T>;
  /** Re-fetch on this cadence, but only while the modal is open (live layers). */
  pollWhileOpenMs?: number;

  /** Chip count readout; null → no number on the chip. */
  count?: (data: T) => number | null;
  /**
   * Exception-based visibility: when the layer is enabled but has no content,
   * the chip AND the layer vanish entirely (empty = invisible — the Pi
   * carousel's insertion grammar). Omit for always-present layers.
   */
  hasContent?: (data: T) => boolean;

  /** Clickable items with px positions (point layers). */
  pickables?: (data: T, view: MercatorView) => Array<{ item: unknown; x: number; y: number }>;
  /** Vector rendering inside the shared SVG (dots, polygons, trails). */
  renderSvg?: (data: T, view: MercatorView, picked: CityPick | null) => ReactNode;
  /** Field rendering under the SVG (tile overlays like radar). */
  renderUnder?: (data: T, view: MercatorView) => ReactNode;
  /** Detail-strip line for a picked item (data provided for context, e.g.
   *  "+N more at this block" needs the full list). Fallback when the layer has
   *  no `detailCard`. */
  detail?: (item: unknown, data: T) => ReactNode;
  /** Structured card for a picked item (#131) — preferred over `detail` when
   *  present; the card framework renders it uniformly across layers. */
  detailCard?: (item: unknown, data: T) => CityDetail;
  /** Legend fragment (counts, color key). */
  legend?: (data: T) => ReactNode;
}

// ── Enabled-state persistence (extends the existing key/pattern) ──────────
const LAYERS_KEY = 'orrery:citymap:layers';

export function loadEnabledCity(defs: CityLayerDef[]): Record<string, boolean> {
  let saved: Record<string, boolean> = {};
  try {
    saved = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    /* defaults */
  }
  const out: Record<string, boolean> = {};
  for (const d of defs) out[d.id] = saved[d.id] ?? d.defaultOn;
  return out;
}

export function saveEnabledCity(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}
