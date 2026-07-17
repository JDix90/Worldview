/**
 * Generic detail card for layer objects (satellites, quakes, regions) —
 * same instrument aesthetic and position family as AircraftCard.
 */
import type { LayerCard } from '../layers/registry';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const style: React.CSSProperties = {
  position: 'fixed',
  bottom: 14,
  left: 12,
  minWidth: 230,
  maxWidth: 320,
  padding: '10px 12px',
  font: `11px/1.6 ${mono}`,
  color: 'rgba(200, 214, 229, 0.92)',
  background: 'rgba(6, 10, 16, 0.88)',
  border: '1px solid rgba(79, 216, 255, 0.25)',
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
};

export function ObjectCard({ card, onClose }: { card: LayerCard; onClose: () => void }) {
  return (
    <div style={style}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: '#4fd8ff', fontWeight: 600, letterSpacing: 1 }}>{card.title}</span>
        {card.subtitle && <span style={{ opacity: 0.55 }}>{card.subtitle}</span>}
        <span style={{ flex: 1 }} />
        <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
      </div>
      {card.note && (
        <div style={{ marginTop: 5, opacity: 0.75, lineHeight: 1.45 }}>{card.note}</div>
      )}
      <div style={{ marginTop: 6 }}>
        {card.rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', gap: 10 }}>
            <span style={{ opacity: 0.5, minWidth: 100 }}>{r.label}</span>
            <span>{r.value}</span>
          </div>
        ))}
      </div>
      {card.href && (
        <a
          href={card.href}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#4fd8ff', opacity: 0.8, display: 'inline-block', marginTop: 6 }}
        >
          details ↗
        </a>
      )}
    </div>
  );
}
