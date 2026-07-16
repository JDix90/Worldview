/**
 * Military aircraft — adsb.fi's mil-flagged feed, arriving on the same
 * WebSocket as `mil` frames into a second AircraftStore (same dead-reckoning
 * as the main layer). Rendered as green darts, slightly larger than civil
 * traffic; the card carries type/registration when adsb.fi knows them.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import type { AircraftStore } from '../feed/aircraftStore';
import { latLngToWorld, writeHeadingMatrix, GLOBE_RADIUS, EARTH_RADIUS_M } from '../globe/surfaceMath';

const MAX_INSTANCES = 3000;
const BASE_CLEARANCE = 0.5;
const ALT_EXAGGERATION = 3;
const PICK_RADIUS_PX = 18;
const MIL_COLOR = 0x8fe36b;

export function makeMilLayer(store: AircraftStore): LayerDef {
  return {
    id: 'mil',
    label: 'MILITARY AIR',
    defaultOn: true,
    attribution: 'adsb.fi',
    init(ctx: LayerCtx): LayerInstance {
      const geometry = new THREE.ConeGeometry(0.48, 2.0, 4);
      geometry.rotateX(Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({ color: MIL_COLOR });
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      ctx.scene.add(mesh);

      const matrices = mesh.instanceMatrix.array as Float32Array;
      const idxToHex: string[] = new Array(MAX_INSTANCES);
      const positions = new Float32Array(MAX_INSTANCES * 3);
      let activeCount = 0;
      const pos = new THREE.Vector3();
      const proj = new THREE.Vector3();
      let lastMs = 0;

      const unregister = ctx.registerPicker((px, py, rect, camera) => {
        let best: { d2: number; hex: string } | null = null;
        for (let i = 0; i < activeCount; i++) {
          proj.fromArray(positions, i * 3);
          if (proj.dot(camera.position) < GLOBE_RADIUS * GLOBE_RADIUS) continue;
          proj.project(camera);
          const sx = ((proj.x + 1) / 2) * rect.width;
          const sy = ((1 - proj.y) / 2) * rect.height;
          const d2 = (sx - px) ** 2 + (sy - py) ** 2;
          if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, hex: idxToHex[i]! };
        }
        if (!best) return null;
        const hex = best.hex;
        return {
          d2: best.d2,
          open: () => {
            const t = store.byHex.get(hex);
            if (!t) return;
            const s = t.state;
            ctx.setCard({
              title: s.callsign ?? hex.toUpperCase(),
              subtitle: 'military',
              rows: [
                ...(s.typeCode ? [{ label: 'TYPE', value: s.typeCode }] : []),
                ...(s.registration ? [{ label: 'REG', value: s.registration }] : []),
                { label: 'HEX', value: hex },
                { label: 'ALT', value: s.altBaroM !== undefined ? `${Math.round(s.altBaroM * 3.28084).toLocaleString()} ft` : '—' },
                { label: 'GS', value: s.groundSpeedMs !== undefined ? `${Math.round(s.groundSpeedMs * 1.94384)} kt` : '—' },
                { label: 'TRK', value: s.trackDeg !== undefined ? `${Math.round(s.trackDeg)}°` : '—' },
                ...(s.squawk ? [{ label: 'SQK', value: s.squawk }] : []),
              ],
            });
          },
        };
      });

      return {
        update(nowMs, camDist) {
          const dtS = lastMs > 0 ? Math.min((nowMs - lastMs) / 1000, 0.25) : 0.016;
          lastMs = nowMs;
          const s = Math.min(Math.max(camDist / 280, 0.5), 1.8);
          activeCount = store.frame(dtS, (i, hex, lat, lon, altM, trackDeg) => {
            if (i >= MAX_INSTANCES) return;
            idxToHex[i] = hex;
            const altUnits = BASE_CLEARANCE / GLOBE_RADIUS + (altM / EARTH_RADIUS_M) * ALT_EXAGGERATION;
            latLngToWorld(lat, lon, altUnits, pos);
            positions[i * 3] = pos.x;
            positions[i * 3 + 1] = pos.y;
            positions[i * 3 + 2] = pos.z;
            writeHeadingMatrix(matrices, i, pos, trackDeg, s);
          });
          mesh.count = activeCount;
          mesh.instanceMatrix.needsUpdate = true;
        },
        dispose() {
          unregister();
          ctx.scene.remove(mesh);
          geometry.dispose();
          material.dispose();
        },
      };
    },
  };
}
