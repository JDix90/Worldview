/**
 * CITY layer toggles in the bottom-right cluster (#132) — the CITY counterpart
 * of the globe's LayersPanel, in the same corner with the same grammar, so
 * "show/hide what's drawn" lives in one place regardless of which view you're
 * in. Richer than the globe panel because city layers carry colour + live
 * counts + a one-line description (the old top-left ⊞ drawer, relocated).
 */
import { Chip } from './Chip';
import { C, mono, pressable } from './uiKit';
import type { CityLayerDef } from '../city/registry';
import type { CityMapState } from '../feed/useCityMap';

const panel: React.CSSProperties = {
  position: 'fixed',
  zIndex: 60, // above the CITY map portal (#132)
  bottom: 14,
  right: 12,
  width: 244,
  maxHeight: 'min(70vh, 520px)',
  overflowY: 'auto',
  padding: '10px 12px',
  font: `11px/1.7 ${mono}`,
  color: C.text,
  background: C.panel,
  border: `1px solid ${C.edge}`,
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
  userSelect: 'none',
  boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
};

interface Props {
  defs: CityLayerDef[];
  city: CityMapState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chipVisible: boolean;
  bottom: number;
}

export function CityLayersPanel({ defs, city, open, onOpenChange, chipVisible, bottom }: Props) {
  const onCount = defs.filter((d) => city.enabled[d.id] ?? d.defaultOn).length;

  if (!open) {
    if (!chipVisible) return null;
    return (
      <Chip
        bottom={bottom}
        label="LAYERS"
        state={`${onCount}/${defs.length}`}
        opens
        title="Show or hide CITY data layers"
        onClick={() => onOpenChange(true)}
      />
    );
  }

  const countOf = (d: CityLayerDef) => {
    const data = city.data[d.id];
    if (data === undefined || data === null) return '…';
    if (data === 'unavailable') return '—';
    return d.count?.(data as never) ?? '';
  };

  return (
    <div style={panel}>
      <div style={{ display: 'flex', marginBottom: 6 }}>
        <span style={{ color: C.cyan, letterSpacing: 1 }}>CITY LAYERS</span>
        <span style={{ flex: 1 }} />
        <span className="orx-x" {...pressable(() => onOpenChange(false))} aria-label="Close" style={{ cursor: 'pointer' }}>✕</span>
      </div>
      {defs.map((d) => {
        const on = city.enabled[d.id] ?? d.defaultOn;
        const data = city.data[d.id];
        const hasData = on && data !== undefined && data !== null && data !== 'unavailable';
        // Per-layer legend/freshness lives here now (#133) — moved off the map's
        // bottom bar, shown only for the enabled layer whose detail it explains.
        const legend = hasData ? d.legend?.(data as never) : null;
        return (
          <div key={d.id} style={{ opacity: on ? 1 : 0.5 }}>
            <div
              className="orx-row"
              {...pressable(() => city.toggle(d.id))}
              aria-pressed={on}
              title={d.describe}
              style={{
                cursor: 'pointer',
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                padding: '3px 4px',
                margin: '0 -4px',
                borderRadius: 3,
              }}
            >
              <span style={{ color: on ? d.chipColor : C.dimmer, width: 12 }}>{on ? '◉' : '○'}</span>
              <span style={{ minWidth: 66 }}>{d.label}</span>
              <span style={{ opacity: 0.5, fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.describe}
              </span>
              <span style={{ opacity: 0.55, fontSize: 10 }}>{countOf(d)}</span>
            </div>
            {legend && (
              <div style={{ paddingLeft: 20, marginBottom: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>{legend}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
