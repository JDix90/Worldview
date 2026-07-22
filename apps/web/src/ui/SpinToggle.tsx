/**
 * Auto-rotate toggle — part of the bottom-right control cluster. Pausing is
 * permanent until re-enabled (the drag-pause/resume behavior only applies
 * while spin is enabled).
 */
import { Chip, CHIP_CYAN, CHIP_DIM } from './Chip';

interface Props {
  enabled: boolean;
  onToggle: () => void;
  bottom: number;
}

export function SpinToggle({ enabled, onToggle, bottom }: Props) {
  return (
    <Chip
      bottom={bottom}
      label="SPIN"
      state={enabled ? 'ON' : 'OFF'}
      stateColor={enabled ? CHIP_CYAN : CHIP_DIM}
      title={enabled ? 'Globe auto-rotates — click to pause' : 'Auto-rotate paused — click to resume'}
      onClick={onToggle}
    />
  );
}
