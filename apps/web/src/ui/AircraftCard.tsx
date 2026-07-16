/**
 * Selected-aircraft readout. Data refreshes at 1Hz — the card shows the
 * reported state and its age; the marker on the globe is what interpolates.
 */
import { useEffect, useState } from 'react';
import type { AircraftStore, Tracked } from '../feed/aircraftStore';

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;
const MS_TO_FPM = 196.85;

const panel: React.CSSProperties = {
  position: 'fixed',
  bottom: 14,
  left: 12,
  minWidth: 220,
  padding: '10px 12px',
  font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'rgba(200, 214, 229, 0.95)',
  background: 'rgba(8, 12, 18, 0.82)',
  border: '1px solid rgba(79, 216, 255, 0.25)',
  borderRadius: 4,
};

function row(label: string, value: string): JSX.Element {
  return (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ opacity: 0.55 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function AircraftCard({
  store,
  hex,
  onClose,
}: {
  store: AircraftStore;
  hex: string;
  onClose: () => void;
}) {
  const [tracked, setTracked] = useState<Tracked | null>(() => store.byHex.get(hex) ?? null);

  useEffect(() => {
    setTracked(store.byHex.get(hex) ?? null);
    const id = setInterval(() => setTracked(store.byHex.get(hex) ?? null), 1000);
    return () => clearInterval(id);
  }, [store, hex]);

  if (!tracked) return null;
  const s = tracked.state;
  const ageS = Math.max(0, Math.round(Date.now() / 1000 - s.seenAt));
  const lost = tracked.missingSinceMs !== null;

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: '#4fd8ff', fontWeight: 600 }}>
          {s.callsign ?? '(no callsign)'}
        </span>
        <span
          onClick={onClose}
          style={{ cursor: 'pointer', opacity: 0.6, pointerEvents: 'auto' }}
          title="deselect"
        >
          ✕
        </span>
      </div>
      {row('hex', s.hex)}
      {s.originCountry !== undefined && row('origin', s.originCountry)}
      {s.altBaroM !== undefined && row('alt', `${Math.round(s.altBaroM * M_TO_FT).toLocaleString()} ft`)}
      {s.groundSpeedMs !== undefined && row('gs', `${Math.round(s.groundSpeedMs * MS_TO_KT)} kt`)}
      {s.trackDeg !== undefined && row('trk', `${Math.round(s.trackDeg)}°`)}
      {s.verticalRateMs !== undefined &&
        row('v/s', `${s.verticalRateMs >= 0 ? '+' : ''}${Math.round(s.verticalRateMs * MS_TO_FPM)} fpm`)}
      {s.squawk !== undefined && row('sqk', s.squawk)}
      {s.category !== undefined && row('cat', s.category)}
      {row('data age', `${ageS}s`)}
      {lost && (
        <div style={{ marginTop: 6, color: '#ffb300' }}>SIGNAL LOST — holding last vector</div>
      )}
    </div>
  );
}
