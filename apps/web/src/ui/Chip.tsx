/**
 * Shared chip for the bottom-right control cluster. One component so the
 * stack reads as a single instrument cluster — uniform width, label on the
 * left, state on the right — instead of five hand-rolled variants with
 * ragged widths and cryptic glyphs (fresh-eyes review 2026-07-22).
 */
import type { ReactNode } from 'react';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const CHIP_CYAN = '#4fd8ff';
export const CHIP_DIM = 'rgba(143,163,184,0.6)';
export const CHIP_GREEN = '#6be36b';

const base: React.CSSProperties = {
  position: 'fixed',
  right: 12,
  width: 132,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  cursor: 'pointer',
  font: `11px ${mono}`,
  color: 'rgba(143,163,184,0.85)',
  padding: '4px 10px',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 3,
  background: 'rgba(6,10,16,0.7)',
  userSelect: 'none',
};

interface ChipProps {
  bottom: number;
  label: ReactNode;
  /** Right-aligned state readout (word or glyph). */
  state?: ReactNode;
  stateColor?: string;
  title?: string;
  /**
   * True for chips that open a surface (feed, home, location, layers): adds a
   * trailing chevron + brighter border so "opens something" reads differently
   * from a state toggle (SPIN/SCREEN). Before this the two were visually
   * identical and nothing hinted the panels existed (design review #114).
   */
  opens?: boolean;
  onClick: () => void;
}

export function Chip({ bottom, label, state, stateColor, title, opens, onClick }: ChipProps) {
  const style: React.CSSProperties = opens
    ? { ...base, bottom, border: '1px solid rgba(79,216,255,0.45)' }
    : { ...base, bottom };
  return (
    <div style={style} onClick={onClick} title={title}>
      <span>{label}</span>
      <span style={{ flex: 1 }} />
      {state !== undefined && <span style={{ color: stateColor ?? CHIP_CYAN }}>{state}</span>}
      {opens && <span style={{ color: CHIP_CYAN, opacity: 0.75, marginLeft: 1 }}>›</span>}
    </div>
  );
}
