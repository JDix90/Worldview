/**
 * The CITY map layer roster (round 1, #125). Order = chip/legend/draw order;
 * renderUnder layers (radar) composite below the SVG regardless.
 */
import type { CityLayerDef } from '../registry';
import { crimeLayer } from './crimeLayer';
import { camerasLayer } from './camerasLayer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cityLayerDefs: CityLayerDef<any>[] = [
  crimeLayer,
  camerasLayer,
];
