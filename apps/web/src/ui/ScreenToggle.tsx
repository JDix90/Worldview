/**
 * Appliance screen control — a chip above SPIN that cycles the Pi display's
 * mode: A (auto: 23:00–06:30 schedule + red-wake) → ○ (forced off) → ◉
 * (forced on). Applies via the server pref the display polls (~90 s).
 */
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../feed/api';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const chip: React.CSSProperties = {
  position: 'fixed',
  bottom: 74,
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

type Mode = 'auto' | 'off' | 'on';
const NEXT: Record<Mode, Mode> = { auto: 'off', off: 'on', on: 'auto' };
const GLYPH: Record<Mode, string> = { auto: 'A', off: '○', on: '◉' };
const TITLE: Record<Mode, string> = {
  auto: 'Appliance screen: auto (sleeps 23:00–06:30, wakes on red)',
  off: 'Appliance screen: forced off',
  on: 'Appliance screen: forced on',
};

export function ScreenToggle() {
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    apiGet<{ mode: string }>('/api/display')
      .then((d) => setMode((['auto', 'off', 'on'].includes(d.mode) ? d.mode : 'auto') as Mode))
      .catch(() => setMode('auto'));
  }, []);

  if (mode === null) return null;

  const cycle = () => {
    const next = NEXT[mode];
    setMode(next); // optimistic; display applies within its ~90s poll
    apiPost('/api/display', { mode: next }).catch(() => setMode(mode));
  };

  return (
    <div style={{ ...chip, opacity: mode === 'off' ? 0.6 : 1 }} onClick={cycle} title={TITLE[mode]}>
      SCREEN{' '}
      <span style={{ color: mode === 'off' ? 'rgba(143,163,184,0.6)' : '#4fd8ff' }}>
        {GLYPH[mode]}
      </span>
    </div>
  );
}
