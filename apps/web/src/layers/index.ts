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
import { cyclonesLayer } from './cyclones';
import { wildfiresLayer } from './wildfires';
import { launchesLayer } from './launches';
import { sunMoonLayer } from './sunmoon';
import { aerosolLayer } from './aerosol';
import { windLayer } from './wind/wind';
import { bordersLayer } from './borders';
import { shippingLanesLayer } from './shippingLanes';
import { currentsLayer } from './ocean/currents';

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
    // Flag-only def: the civil-aircraft rendering lives in AircraftLayer.tsx
    // (GlobeView reads this id from layersEnabled). Registered here so it
    // gets the LayersPanel row + persistence like everything else.
    {
      id: 'flights',
      label: 'CIVIL AIR',
      defaultOn: true,
      attribution: 'OpenSky Network',
      init: () => ({ dispose() {} }),
    },
    makeMilLayer(deps.milStore),
    windLayer,
    currentsLayer,
    shippingLanesLayer,
    cyclonesLayer,
    wildfiresLayer,
    aerosolLayer,
    earthquakesLayer,
    launchesLayer,
    jammingLayer,
    auroraLayer,
    sunMoonLayer,
    bordersLayer,
  ];
}
