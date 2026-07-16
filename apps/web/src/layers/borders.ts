/**
 * Base cartography: Natural Earth 50m coastlines + country boundary lines as
 * hairline LineSegments just above the surface. Crisp at every zoom (vector,
 * not raster) — the "defined areas" the raster textures can't provide up
 * close. Opacity fades with camera distance: prominent when zoomed in,
 * unobtrusive from space.
 *
 * Geometry note: segments are subdivided by slerping the endpoint unit
 * vectors in 3D whenever a chord exceeds MAX_SEG_RAD — a 10° straight chord
 * at this radius would sag ~0.38 world units through the globe, and slerp
 * subdivision also makes the ±180° antimeridian a non-issue.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { latLngToWorld } from '../globe/surfaceMath';

const ALT = 0.0015; // r ≈ 100.15 — above the surface, below every data layer
const MAX_SEG_RAD = (2 * Math.PI) / 180;
const BORDER_COLOR = 0x7fb4c8;
// opacity ramp vs camera distance (world units; globe r=100, zoom 115–720)
const NEAR_DIST = 140;
const FAR_DIST = 400;
const NEAR_OPACITY = 0.55;
const FAR_OPACITY = 0.15;
const COAST_FACTOR = 0.7; // coastlines slightly fainter than borders

interface LineFeature {
  geometry: { type: string; coordinates: number[][] | number[][][] };
}

/** Flatten a GeoJSON of LineString/MultiLineString into polylines. */
function polylines(features: LineFeature[]): number[][][] {
  const out: number[][][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === 'LineString') out.push(g.coordinates as number[][]);
    else if (g.type === 'MultiLineString') out.push(...(g.coordinates as number[][][]));
  }
  return out;
}

/** Build slerp-subdivided LineSegments positions from [lon, lat] polylines. */
function buildSegments(lines: number[][][]): Float32Array {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const verts: number[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      latLngToWorld(line[i]![1]!, line[i]![0]!, ALT, a);
      latLngToWorld(line[i + 1]![1]!, line[i + 1]![0]!, ALT, b);
      const radius = a.length();
      p.copy(a).normalize();
      q.copy(b).normalize();
      const angle = p.angleTo(q);
      if (angle < 1e-7) continue;
      const steps = Math.max(1, Math.ceil(angle / MAX_SEG_RAD));
      let prevX = a.x, prevY = a.y, prevZ = a.z;
      for (let s = 1; s <= steps; s++) {
        // slerp p→q by s/steps (stable formulation via rotation axis)
        const t = s / steps;
        const sinA = Math.sin(angle);
        const w1 = Math.sin((1 - t) * angle) / sinA;
        const w2 = Math.sin(t * angle) / sinA;
        const x = (p.x * w1 + q.x * w2) * radius;
        const y = (p.y * w1 + q.y * w2) * radius;
        const z = (p.z * w1 + q.z * w2) * radius;
        verts.push(prevX, prevY, prevZ, x, y, z);
        prevX = x; prevY = y; prevZ = z;
      }
    }
  }
  return Float32Array.from(verts);
}

export const bordersLayer: LayerDef = {
  id: 'borders',
  label: 'BORDERS',
  defaultOn: true,
  attribution: 'Natural Earth',
  init(ctx: LayerCtx): LayerInstance {
    const group = new THREE.Group();
    ctx.scene.add(group);

    const coastMat = new THREE.LineBasicMaterial({
      color: BORDER_COLOR,
      transparent: true,
      opacity: FAR_OPACITY * COAST_FACTOR,
      depthWrite: false,
    });
    const borderMat = new THREE.LineBasicMaterial({
      color: BORDER_COLOR,
      transparent: true,
      opacity: FAR_OPACITY,
      depthWrite: false,
    });
    const geometries: THREE.BufferGeometry[] = [];

    async function load(url: string, mat: THREE.LineBasicMaterial): Promise<void> {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const gj = (await res.json()) as { features: LineFeature[] };
      const positions = buildSegments(polylines(gj.features));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometries.push(geometry);
      group.add(new THREE.LineSegments(geometry, mat));
    }
    void Promise.all([
      load('/geo/ne_50m_coastline.geojson', coastMat),
      load('/geo/ne_50m_admin_0_boundary_lines_land.geojson', borderMat),
    ]).catch((err) => console.warn('[borders] load failed', err));

    return {
      update(_nowMs, camDist) {
        const t = THREE.MathUtils.clamp((FAR_DIST - camDist) / (FAR_DIST - NEAR_DIST), 0, 1);
        const o = FAR_OPACITY + (NEAR_OPACITY - FAR_OPACITY) * t;
        borderMat.opacity = o;
        coastMat.opacity = o * COAST_FACTOR;
      },
      dispose() {
        ctx.scene.remove(group);
        for (const g of geometries) g.dispose();
        coastMat.dispose();
        borderMat.dispose();
      },
    };
  },
};
