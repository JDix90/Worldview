/**
 * Shared card/HUD formatters. Cards follow three rules (DECISIONS #68):
 * lead with a plain-language read, translate jargon while keeping the raw
 * value, and prefer relative times + hemisphere coordinates.
 */

export const M_TO_FT = 3.28084;
export const MS_TO_KT = 1.94384;
export const MS_TO_FPM = 196.85;
export const KT_TO_MPH = 1.15078;

/** "34s ago" / "5.6h ago" / "3d ago" */
export function agoShort(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${(s / 3600).toFixed(1)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "07-16 19:49Z" */
export function utcShort(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
}

/** "46.60°N 118.28°W" */
export function latLon(lat: number, lon: number, dp = 2): string {
  const la = `${Math.abs(lat).toFixed(dp)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(dp)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

/** 236° → "SW" */
export function compass16(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** "110 kt · 127 mph" */
export function ktMph(kt: number): string {
  return `${Math.round(kt)} kt · ${Math.round(kt * KT_TO_MPH)} mph`;
}

/** meters → "3,975 ft" */
export function ftFromM(m: number): string {
  return `${Math.round(m * M_TO_FT).toLocaleString()} ft`;
}

/** Squawk translation — only the three universal emergency codes. */
export function squawkNote(squawk: string): string {
  if (squawk === '7500') return ' — HIJACK CODE';
  if (squawk === '7600') return ' — RADIO FAILURE';
  if (squawk === '7700') return ' — EMERGENCY';
  return '';
}
