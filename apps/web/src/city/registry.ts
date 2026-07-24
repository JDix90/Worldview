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

export function onScreen(view: MercatorView, p: { x: number; y: number }, pad = 4): boolean {
  return p.x >= -pad && p.x <= view.w + pad && p.y >= -pad && p.y <= view.h + pad;
}

/** XYZ tiles covering the viewport (basemap and tile overlays share this). */
export function tileGrid(view: MercatorView): Array<{ x: number; y: number; left: number; top: number }> {
  const n = 2 ** view.z;
  const out: Array<{ x: number; y: number; left: number; top: number }> = [];
  for (let tx = Math.floor(view.originX / TILE); tx <= Math.floor((view.originX + view.w) / TILE); tx++) {
    for (let ty = Math.floor(view.originY / TILE); ty <= Math.floor((view.originY + view.h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      out.push({ x: ((tx % n) + n) % n, y: ty, left: tx * TILE - view.originX, top: ty * TILE - view.originY });
    }
  }
  return out;
}

// ── Layer state ───────────────────────────────────────────────────────────
/** null = loading · 'unavailable' = upstream failed · T = data. */
export type LayerData<T> = T | 'unavailable' | null;

export interface CityPick {
  layerId: string;
  item: unknown;
  x: number;
  y: number;
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
   *  "+N more at this block" needs the full list). */
  detail?: (item: unknown, data: T) => ReactNode;
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
