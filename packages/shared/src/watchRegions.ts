/**
 * GPS-interference watch regions (FOUNDATION §7, DECISIONS #7). Each region is
 * swept as a set of point-radius adsb.fi queries (max 250 NM per tile). Editing
 * this list is the supported way to change what D3 watches.
 */

export interface WatchTile {
  lat: number;
  lon: number;
  radiusNm: number;
}

export interface WatchRegion {
  id: string;
  name: string;
  tiles: WatchTile[];
}

export const GPS_WATCH_REGIONS: WatchRegion[] = [
  {
    id: 'baltic',
    name: 'Baltic / Kaliningrad corridor',
    tiles: [
      { lat: 55.5, lon: 20.0, radiusNm: 250 },
      { lat: 59.5, lon: 24.5, radiusNm: 220 },
    ],
  },
  {
    id: 'black-sea',
    name: 'Black Sea',
    tiles: [
      { lat: 44.0, lon: 34.0, radiusNm: 250 },
      { lat: 42.0, lon: 29.0, radiusNm: 200 },
    ],
  },
  {
    id: 'east-med',
    name: 'Eastern Mediterranean',
    tiles: [{ lat: 34.5, lon: 32.5, radiusNm: 250 }],
  },
  {
    id: 'persian-gulf',
    name: 'Persian Gulf',
    tiles: [{ lat: 26.5, lon: 52.0, radiusNm: 250 }],
  },
];
