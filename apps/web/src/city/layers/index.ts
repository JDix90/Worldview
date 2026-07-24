/**
 * The CITY map layer roster (round 1, #125). Order = chip/legend/draw order;
 * renderUnder layers (radar) composite below the SVG regardless.
 */
import type { CityLayerDef } from '../registry';
import { radarLayer } from './radarLayer';
import { alertsLayer } from './alertsLayer';
import { crimeLayer } from './crimeLayer';
import { camerasLayer } from './camerasLayer';
import { oemLayer } from './oemLayer';

// Order = chip/legend order AND svg draw order (later = on top): radar is a
// field under everything; alert polygons under the point layers; OEM on top.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cityLayerDefs: CityLayerDef<any>[] = [
  radarLayer,
  alertsLayer,
  crimeLayer,
  camerasLayer,
  oemLayer,
];
