/**
 * HOME chip — sets the appliance's home anchor (drives the Pi display's
 * "overhead" and "N mi of you" context) to wherever the globe camera is
 * currently centered. Navigate to your area, click, done. The display picks
 * the change up on its next summary poll (~90 s).
 */
import { useRef, useState } from 'react';
import { apiPost } from '../feed/api';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const chip: React.CSSProperties = {
  position: 'fixed',
  bottom: 104,
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

interface OrreryHandle {
  globe?: { pointOfView(): { lat: number; lng: number; altitude: number } };
}

export function HomeChip() {
  const [flash, setFlash] = useState<'ok' | 'err' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setHome = () => {
    const g = (window as { __ORRERY__?: OrreryHandle }).__ORRERY__?.globe;
    if (!g) return;
    const pov = g.pointOfView();
    apiPost<{ lat: number; lon: number }>('/api/settings/home', { lat: pov.lat, lon: pov.lng })
      .then(() => setFlash('ok'))
      .catch(() => setFlash('err'));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), 2500);
  };

  return (
    <div
      style={{ ...chip, color: flash === 'ok' ? '#6be36b' : flash === 'err' ? '#ff5a5a' : chip.color as string }}
      onClick={setHome}
      title="Set home to the globe's current center — anchors the appliance display's overhead/local view"
    >
      HOME{' '}
      <span style={{ color: flash === 'ok' ? '#6be36b' : '#4fd8ff' }}>
        {flash === 'ok' ? '✓' : flash === 'err' ? '✗' : '⌂'}
      </span>
    </div>
  );
}
