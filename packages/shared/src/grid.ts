/**
 * The density grid: fixed 5°×5° lat/lon cells, id'd by their SW corner
 * ("N50E000" = 50–55°N, 0–5°E). Chosen over H3 in DECISIONS.md: regional-scale
 * anomaly detection needs stable cells, not hexagonal elegance, and the polar
 * area distortion sits where there is no traffic.
 */

export const CELL_SIZE_DEG = 5;

export function cellIdFor(lat: number, lon: number): string {
  const clampedLat = Math.min(Math.max(lat, -90), 89.999);
  const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const latBand = Math.floor(clampedLat / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const lonBand = Math.floor(normLon / CELL_SIZE_DEG) * CELL_SIZE_DEG;
  const latPart = `${latBand < 0 ? 'S' : 'N'}${String(Math.abs(latBand)).padStart(2, '0')}`;
  const lonPart = `${lonBand < 0 ? 'W' : 'E'}${String(Math.abs(lonBand)).padStart(3, '0')}`;
  return latPart + lonPart;
}

/** Center of a cell, for Signal.where and display. Inverse of cellIdFor's corner encoding. */
export function cellCenter(cellId: string): { lat: number; lon: number } {
  const m = /^([NS])(\d{2})([EW])(\d{3})$/.exec(cellId);
  if (!m) throw new Error(`bad cell id: ${cellId}`);
  // the encoded corner is the SW (lower) edge in every hemisphere, so the
  // center is always corner + half a cell
  const lat = (m[1] === 'S' ? -1 : 1) * Number(m[2]) + CELL_SIZE_DEG / 2;
  const lon = (m[3] === 'W' ? -1 : 1) * Number(m[4]) + CELL_SIZE_DEG / 2;
  return { lat, lon };
}
