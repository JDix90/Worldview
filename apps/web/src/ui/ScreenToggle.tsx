/**
 * Appliance screen control — cycles the Pi display's mode: AUTO (23:00–06:30
 * schedule + red-wake) → OFF (forced off) → ON (forced on). Applies via the
 * server pref the display polls (~90 s).
 */
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../feed/api';
import { Chip, CHIP_CYAN, CHIP_DIM } from './Chip';

type Mode = 'auto' | 'off' | 'on';
const NEXT: Record<Mode, Mode> = { auto: 'off', off: 'on', on: 'auto' };
const WORD: Record<Mode, string> = { auto: 'AUTO', off: 'OFF', on: 'ON' };
const TITLE: Record<Mode, string> = {
  auto: 'Appliance screen: auto (sleeps 23:00–06:30, wakes on red) — click to force off',
  off: 'Appliance screen: forced off — click to force on',
  on: 'Appliance screen: forced on — click for auto',
};

export function ScreenToggle({ bottom }: { bottom: number }) {
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
    <Chip
      bottom={bottom}
      label="SCREEN"
      state={WORD[mode]}
      stateColor={mode === 'off' ? CHIP_DIM : CHIP_CYAN}
      title={TITLE[mode]}
      onClick={cycle}
    />
  );
}
