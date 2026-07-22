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
import { vesselsLayer } from './vessels/vessels';
import { cloudsLayer } from './clouds';
import { worldEventsLayer } from './worldEvents';
import { rainLayer } from './rain';
import { airportDelaysLayer } from './airportDelays';

export function buildLayerDefs(deps: { milStore: AircraftStore }): LayerDef[] {
  return [
    // Default roster trimmed 2026-07-22 (DECISIONS #109): the flagship
    // (flights + anomalies) and the event layers stay on; ambient texture
    // (satellites, wind, currents, aerosol) and key-blocked sources
    // (vessels, fires) are opt-in. Everything remains one toggle away.
    makeSatellitesLayer({
      id: 'sats',
      label: 'SATELLITES',
      defaultOn: false,
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
    vesselsLayer,
    windLayer,
    currentsLayer,
    shippingLanesLayer,
    cyclonesLayer,
    wildfiresLayer,
    // drape stack, bottom-up: clouds → rain → smoke (same renderOrder; mount
    // order controls compositing)
    cloudsLayer,
    rainLayer,
    aerosolLayer,
    earthquakesLayer,
    worldEventsLayer,
    airportDelaysLayer,
    launchesLayer,
    jammingLayer,
    auroraLayer,
    sunMoonLayer,
    bordersLayer,
  ];
}
