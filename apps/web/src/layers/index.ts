/**
 * The layer roster (Phase 1.5). Order here is display order in LayersPanel.
 */
import type { AircraftStore } from '../feed/aircraftStore';
import type { LayerDef } from './registry';
import { earthquakesLayer } from './earthquakes';
import { makeSatellitesLayer } from './satellites/satellites';
import { auroraLayer } from './aurora';
import { makeMilLayer } from './milAircraft';
import { jammingLayer } from './jamming';

export function buildLayerDefs(deps: { milStore: AircraftStore }): LayerDef[] {
  return [
    makeSatellitesLayer({
      id: 'sats',
      label: 'SATELLITES',
      defaultOn: true,
      // weather = GOES/Meteosat/Himawari et al — populates the GEO ring
      groups: ['stations', 'gps-ops', 'galileo', 'beidou', 'glo-ops', 'visual', 'weather'],
      color: 0x9adcf0,
      tickMs: 1000,
      maxInstances: 1200,
    }),
    makeSatellitesLayer({
      id: 'starlink',
      label: 'STARLINK SHELL',
      defaultOn: false,
      groups: ['starlink'],
      color: 0x6f92b8,
      tickMs: 2000,
      maxInstances: 9000,
    }),
    makeMilLayer(deps.milStore),
    earthquakesLayer,
    jammingLayer,
    auroraLayer,
  ];
}
