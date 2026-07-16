/**
 * Shared surface/orientation math for globe layers. The lat/lng→world
 * convention mirrors three-globe's polar→cartesian (verified against
 * globe.getCoords at AircraftLayer mount).
 */
import type * as THREE from 'three';

export const GLOBE_RADIUS = 100;
export const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

export function latLngToWorld(
  lat: number,
  lng: number,
  altUnits: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const r = GLOBE_RADIUS * (1 + altUnits);
  const phi = (90 - lat) * DEG;
  const theta = (90 - lng) * DEG;
  const sinPhi = Math.sin(phi);
  return out.set(r * sinPhi * Math.cos(theta), r * Math.cos(phi), r * sinPhi * Math.sin(theta));
}

/**
 * Pack a TRS matrix directly into an InstancedMesh buffer: basis Y = surface
 * normal, Z = heading direction (geometry nose), X = their cross product.
 * All three exactly orthonormal by construction — no normalization pass.
 */
export function writeHeadingMatrix(
  out: Float32Array,
  i: number,
  pos: THREE.Vector3,
  trackDeg: number,
  scale: number,
): void {
  const len = pos.length();
  const nx = pos.x / len;
  const ny = pos.y / len;
  const nz = pos.z / len;

  // east/north tangent frame (degenerate at the exact poles)
  const eLen = Math.hypot(nz, nx) || 1e-9;
  const ex = nz / eLen;
  const ez = -nx / eLen;
  const nox = -ny * ez;
  const noy = nz * ez - nx * ex;
  const noz = ny * ex;

  const tr = trackDeg * DEG;
  const st = Math.sin(tr);
  const ct = Math.cos(tr);
  const fx = ex * st + nox * ct;
  const fy = noy * ct;
  const fz = ez * st + noz * ct;
  const xx = ny * fz - nz * fy;
  const xy = nz * fx - nx * fz;
  const xz = nx * fy - ny * fx;

  const o = i * 16;
  out[o] = xx * scale;      out[o + 1] = xy * scale;  out[o + 2] = xz * scale;  out[o + 3] = 0;
  out[o + 4] = nx * scale;  out[o + 5] = ny * scale;  out[o + 6] = nz * scale;  out[o + 7] = 0;
  out[o + 8] = fx * scale;  out[o + 9] = fy * scale;  out[o + 10] = fz * scale; out[o + 11] = 0;
  out[o + 12] = pos.x;      out[o + 13] = pos.y;      out[o + 14] = pos.z;      out[o + 15] = 1;
}
