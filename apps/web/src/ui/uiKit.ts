/**
 * Shared UI kit (#132): the small set of tokens + interaction styles that keep
 * the globe and CITY views reading as one instrument.
 *
 * The app styles inline, which can't express `:hover`/`:focus-visible`. So this
 * module injects ONE stylesheet of utility classes — `orx-chip`, `orx-row`,
 * `orx-x` — whose hover/focus rules use `!important` deliberately, because an
 * inline `border`/`color` would otherwise win. Add a class to any control and
 * it gets consistent hover + a focus ring (the a11y foundation) for free.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';

export const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Phone breakpoint — shared by the cluster rhythm and the CITY chrome so
 *  "narrow" means one thing app-wide. */
export const NARROW_BP = 640;

/** Re-render on crossing the phone breakpoint. */
export function useNarrow(bp = NARROW_BP): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return narrow;
}

/** Instrument palette — the colours already scattered across the UI, named. */
export const C = {
  cyan: '#4fd8ff',
  dim: 'rgba(143,163,184,0.85)',
  dimmer: 'rgba(143,163,184,0.6)',
  text: 'rgba(200,214,229,0.92)',
  bright: '#eaf1f8',
  green: '#6be36b',
  amber: '#ffb300',
  red: '#ff5a5a',
  violet: '#b98cff',
  panel: 'rgba(6,10,16,0.88)',
  panelSolid: 'rgba(9,14,20,0.98)',
  edge: 'rgba(79,216,255,0.25)',
  edgeBright: 'rgba(79,216,255,0.45)',
} as const;

/** The instrument's three type sizes (tiny readouts · body · emphasis). One
 *  place so a new surface can't invent a fourth. */
export const FS = { tiny: 9, small: 10, base: 11, lg: 12 } as const;

/**
 * Make a click-only `<span>`/`<div>` control keyboard-operable (a11y floor,
 * #133): spreads role="button", tabIndex, and Enter/Space activation. Pair
 * with an `orx-*` class so the injected `:focus-visible` ring shows. Use for
 * the controls that aren't the `Chip` component (✕, drawer rows, map buttons).
 */
export function pressable(onClick: () => void): {
  role: 'button';
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}

const STYLE_ID = 'orx-ui-styles';
const CSS = `
.orx-chip, .orx-row, .orx-x { transition: border-color .12s ease, background-color .12s ease, color .12s ease, opacity .12s ease; }
.orx-chip:hover { border-color: rgba(79,216,255,0.6) !important; background: rgba(79,216,255,0.08) !important; }
.orx-row:hover { background: rgba(120,150,180,0.10) !important; }
.orx-x { opacity: 0.7; }
.orx-x:hover { color: #eaf1f8 !important; opacity: 1 !important; }
.orx-chip:focus-visible, .orx-row:focus-visible, .orx-x:focus-visible,
button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid rgba(79,216,255,0.7); outline-offset: 1px;
}
@keyframes orx-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.orx-loading { animation: orx-pulse 1.1s ease-in-out infinite; }
@media (max-width: 640px) {
  /* Bigger touch targets on phones — the cluster's fixed rhythm is widened to
     match in App (#133). Only the fixed cluster chips, not the inline ones. */
  .orx-chip-cluster { padding-top: 9px !important; padding-bottom: 9px !important; }
}
`;

/** Inject the shared stylesheet once (idempotent). Runs on first import. */
export function ensureUiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

ensureUiStyles();
