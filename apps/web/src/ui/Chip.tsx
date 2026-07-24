/**
 * One chip, two shapes (#132). The bottom-right control cluster and the CITY
 * top bar used to be hand-rolled cousins with different fonts, padding, and
 * borders — the inconsistency the owner flagged. Now both render `Chip`:
 *
 * - `cluster` (default): the fixed 132px surface in the bottom-right stack —
 *   label left, state right, `›` chevron for surfaces that open a panel.
 * - `compact`: an inline auto-width pill for the CITY layer chips — accent
 *   colour + count, lit when active. `size="lg"` grows the touch target on
 *   phones.
 *
 * Both carry the shared `orx-chip` hover/focus grammar (uiKit).
 */
import type { ReactNode } from 'react';
import { mono, C, pressable } from './uiKit';

export const CHIP_CYAN = C.cyan;
export const CHIP_DIM = C.dimmer;
export const CHIP_GREEN = C.green;

const clusterBase: React.CSSProperties = {
  position: 'fixed',
  right: 12,
  // Above the CITY map portal (zIndex 50) so the cluster stays usable in both
  // views — it is the shared navigation now, not globe-only chrome (#132).
  zIndex: 60,
  width: 132,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  cursor: 'pointer',
  font: `11px ${mono}`,
  color: C.dim,
  padding: '4px 10px',
  border: `1px solid ${C.edge}`,
  borderRadius: 3,
  background: 'rgba(6,10,16,0.7)',
  userSelect: 'none',
};

interface ChipProps {
  label: ReactNode;
  /** Right-aligned state readout (cluster) — word or glyph. */
  state?: ReactNode;
  stateColor?: string;
  title?: string;
  onClick?: () => void;
  /**
   * Cluster: chips that open a surface (feed/home/location/layers, and the
   * GLOBE-back chip in CITY) get a trailing chevron + brighter border so
   * "opens something" reads differently from a state toggle (SPIN/SCREEN).
   */
  opens?: boolean;

  variant?: 'cluster' | 'compact';
  // cluster only:
  bottom?: number;
  // compact only:
  /** Count/glyph after the label. */
  count?: ReactNode;
  /** Lit/selected — brighter border, accent text. */
  active?: boolean;
  /** Accent colour when active (defaults to cyan). */
  accent?: string;
  /** Larger padding for touch. */
  size?: 'sm' | 'lg';
  /** Pulse the chip while its data is still loading (#133). */
  loading?: boolean;
}

export function Chip({
  label,
  state,
  stateColor,
  title,
  onClick,
  opens,
  variant = 'cluster',
  bottom,
  count,
  active,
  accent = C.cyan,
  size = 'sm',
  loading,
}: ChipProps) {
  // Click-only spans are made keyboard-operable (#133); no-op keydown when the
  // chip isn't interactive.
  const a11y = onClick ? pressable(onClick) : {};

  if (variant === 'compact') {
    const style: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 5,
      cursor: 'pointer',
      font: `${size === 'lg' ? 12 : 10}px ${mono}`,
      padding: size === 'lg' ? '7px 11px' : '3px 8px',
      borderRadius: 3,
      border: `1px solid ${active ? 'rgba(191,232,245,0.4)' : 'rgba(143,163,184,0.25)'}`,
      color: active ? accent : C.dimmer,
      background: C.panel,
      whiteSpace: 'nowrap',
      userSelect: 'none',
    };
    return (
      <span className={`orx-chip${loading ? ' orx-loading' : ''}`} style={style} title={title} {...a11y}>
        <span>{label}</span>
        {count !== undefined && count !== null && count !== '' && <span>{count}</span>}
      </span>
    );
  }

  const style: React.CSSProperties = {
    ...clusterBase,
    bottom,
    border: opens ? `1px solid ${C.edgeBright}` : `1px solid ${C.edge}`,
  };
  return (
    <div className="orx-chip orx-chip-cluster" style={style} title={title} {...a11y}>
      <span>{label}</span>
      <span style={{ flex: 1 }} />
      {state !== undefined && <span style={{ color: stateColor ?? C.cyan }}>{state}</span>}
      {opens && <span style={{ color: C.cyan, opacity: 0.75, marginLeft: 1 }}>›</span>}
    </div>
  );
}
