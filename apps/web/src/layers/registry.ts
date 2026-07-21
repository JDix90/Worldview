/**
 * Layer framework (Phase 1.5, DECISIONS #46-47). A layer is render-only globe
 * furniture: it may fetch public data and draw, but it emits no Signals and
 * touches no Stage 2-4 machinery. Layers register through LAYER_DEFS (see
 * layers/index.ts) and are mounted/unmounted by GlobeView.
 *
 * Picking is centralized: GlobeView owns ONE pointer handler; each layer
 * registers a Picker that returns its nearest candidate for a click, and the
 * globally nearest candidate wins. This keeps click targets forgiving without
 * layers fighting over pointer events.
 */
import type { GlobeMethods } from 'react-globe.gl';
import type * as THREE from 'three';

export interface LayerCardRow {
  label: string;
  value: string;
}

/** Generic detail card rendered by ObjectCard (bottom-left, instrument style). */
export interface LayerCard {
  title: string;
  subtitle?: string;
  /** One plain-language line — what this is / whether it matters (duty-officer voice). */
  note?: string;
  rows: LayerCardRow[];
  href?: string;
  /** When set, ObjectCard offers a ⤓ fly action that points the globe here. */
  fly?: { lat: number; lng: number };
}

export interface PickCandidate {
  /** Squared distance in CSS px from the click point. */
  d2: number;
  open: () => void;
}

export type Picker = (
  px: number,
  py: number,
  rect: DOMRect,
  camera: THREE.PerspectiveCamera,
) => PickCandidate | null;

export interface LayerCtx {
  globe: GlobeMethods;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Shared world-space sun direction (same vector the terminator uses). */
  getSunDir: () => THREE.Vector3;
  setCard: (card: LayerCard | null) => void;
  /** Returns an unregister function; call it in dispose(). */
  registerPicker: (picker: Picker) => () => void;
}

export interface LayerInstance {
  update?: (nowMs: number, camDist: number) => void;
  dispose: () => void;
}

export interface LayerDef {
  id: string;
  label: string;
  defaultOn: boolean;
  attribution?: string;
  init: (ctx: LayerCtx) => LayerInstance;
}

const STORAGE_KEY = 'orrery:layers';

export function loadEnabled(defs: LayerDef[]): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, boolean>;
      return new Set(defs.filter((d) => saved[d.id] ?? d.defaultOn).map((d) => d.id));
    }
  } catch {
    /* fall through to defaults */
  }
  return new Set(defs.filter((d) => d.defaultOn).map((d) => d.id));
}

export function saveEnabled(defs: LayerDef[], enabled: Set<string>): void {
  const out: Record<string, boolean> = {};
  for (const d of defs) out[d.id] = enabled.has(d.id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}
