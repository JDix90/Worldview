/**
 * Layer toggles — bottom-right chip that expands to one switch per layer,
 * with data attribution. Enabled-set persists via layers/registry.
 */
import type { LayerDef } from '../layers/registry';
import { Chip } from './Chip';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const panel: React.CSSProperties = {
  position: 'fixed',
  bottom: 14,
  right: 12,
  width: 220,
  padding: '10px 12px',
  font: `11px/1.7 ${mono}`,
  color: 'rgba(200,214,229,0.92)',
  background: 'rgba(6,10,16,0.88)',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
  userSelect: 'none',
};

interface Props {
  defs: LayerDef[];
  enabled: Set<string>;
  onToggle: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chip hides while another right-dock panel is open (one surface at a time). */
  chipVisible: boolean;
  bottom: number;
}

export function LayersPanel({ defs, enabled, onToggle, open, onOpenChange, chipVisible, bottom }: Props) {
  if (!open) {
    if (!chipVisible) return null;
    return (
      <Chip
        bottom={bottom}
        label="LAYERS"
        state={`${[...enabled].length}/${defs.length}`}
        title="Show or hide globe data layers"
        onClick={() => onOpenChange(true)}
      />
    );
  }

  const attributions = [...new Set(defs.filter((d) => d.attribution).map((d) => d.attribution!))];

  return (
    <div style={panel}>
      <div style={{ display: 'flex', marginBottom: 6 }}>
        <span style={{ color: '#4fd8ff', letterSpacing: 1 }}>LAYERS</span>
        <span style={{ flex: 1 }} />
        <span onClick={() => onOpenChange(false)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
      </div>
      {defs.map((d) => {
        const on = enabled.has(d.id);
        return (
          <div
            key={d.id}
            onClick={() => onToggle(d.id)}
            style={{ cursor: 'pointer', display: 'flex', gap: 8, opacity: on ? 1 : 0.45 }}
          >
            <span style={{ color: on ? '#4fd8ff' : 'rgba(143,163,184,0.6)' }}>{on ? '◉' : '○'}</span>
            <span>{d.label}</span>
          </div>
        );
      })}
      <div style={{ marginTop: 8, opacity: 0.4, fontSize: 9, lineHeight: 1.5 }}>
        {attributions.join(' · ')}
      </div>
    </div>
  );
}
