/**
 * Auto-rotate toggle — a chip stacked just above the LAYERS chip. Pausing is
 * permanent until re-enabled (the drag-pause/resume behavior only applies
 * while spin is enabled).
 */
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const chip: React.CSSProperties = {
  position: 'fixed',
  bottom: 44,
  right: 12,
  cursor: 'pointer',
  font: `11px ${mono}`,
  color: 'rgba(143,163,184,0.85)',
  padding: '4px 10px',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 3,
  background: 'rgba(6,10,16,0.7)',
  userSelect: 'none',
};

interface Props {
  enabled: boolean;
  onToggle: () => void;
}

export function SpinToggle({ enabled, onToggle }: Props) {
  return (
    <div style={{ ...chip, opacity: enabled ? 1 : 0.6 }} onClick={onToggle}>
      SPIN{' '}
      <span style={{ color: enabled ? '#4fd8ff' : 'rgba(143,163,184,0.6)' }}>
        {enabled ? '◉' : '○'}
      </span>
    </div>
  );
}
