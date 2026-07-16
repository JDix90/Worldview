/**
 * GPS-jamming overlay — OUR OWN live integrity data (the same NIC≤4 sweeps
 * D3 consumes) tinting the watch-region tiles. gpsjam.org does this daily;
 * this is live, from our pipeline. Absolute color scale for v1 (green <15%
 * → amber → red ≥45%); v2 can tint against each region's own norm.
 */
import * as THREE from 'three';
import { GPS_WATCH_REGIONS } from '@orrery/shared';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { apiGet } from '../feed/api';
import { latLngToWorld, GLOBE_RADIUS } from '../globe/surfaceMath';

const REFRESH_MS = 60_000;
const PICK_RADIUS_PX = 40;
const NM_TO_KM = 1.852;

interface RegionNow {
  regionId: string;
  name: string;
  fraction: number | null;
  aircraft: number;
  fetchedAt: number;
}

function fractionColor(f: number): THREE.Color {
  // green (0.15) → amber (0.30) → red (0.45+)
  const t = Math.min(Math.max((f - 0.15) / 0.3, 0), 1);
  return new THREE.Color().setHSL((1 - t) * 0.33, 0.9, 0.5);
}

export const jammingLayer: LayerDef = {
  id: 'jamming',
  label: 'GPS JAMMING',
  defaultOn: true,
  attribution: 'ORRERY integrity sweeps',
  init(ctx: LayerCtx): LayerInstance {
    const group = new THREE.Group();
    ctx.scene.add(group);

    interface TileMesh {
      regionId: string;
      mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
      center: THREE.Vector3;
    }
    const tiles: TileMesh[] = [];
    const up = new THREE.Vector3(0, 0, 1);
    const q = new THREE.Quaternion();

    for (const region of GPS_WATCH_REGIONS) {
      for (const tile of region.tiles) {
        // tile radius in world units along the surface
        const radiusUnits = (tile.radiusNm * NM_TO_KM / 6371) * GLOBE_RADIUS;
        const geometry = new THREE.CircleGeometry(radiusUnits, 48);
        const material = new THREE.MeshBasicMaterial({
          color: 0x555555,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        const center = latLngToWorld(tile.lat, tile.lon, 0.004, new THREE.Vector3());
        mesh.position.copy(center);
        q.setFromUnitVectors(up, center.clone().normalize());
        mesh.quaternion.copy(q);
        mesh.renderOrder = 1;
        group.add(mesh);
        tiles.push({ regionId: region.id, mesh, center });
      }
    }

    let latest: RegionNow[] = [];
    async function refresh(): Promise<void> {
      try {
        const data = await apiGet<{ regions: RegionNow[] }>('/api/integrity/now');
        latest = data.regions;
        for (const t of tiles) {
          const r = latest.find((x) => x.regionId === t.regionId);
          if (r && r.fraction !== null && r.aircraft >= 5) {
            t.mesh.material.color.copy(fractionColor(r.fraction));
            t.mesh.material.opacity = 0.22;
          } else {
            t.mesh.material.color.set(0x555555);
            t.mesh.material.opacity = 0.1;
          }
        }
      } catch (err) {
        console.warn('[jamming] refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      let best: { d2: number; regionId: string } | null = null;
      for (const t of tiles) {
        proj.copy(t.center);
        if (proj.dot(camera.position) < GLOBE_RADIUS * GLOBE_RADIUS) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, regionId: t.regionId };
      }
      if (!best) return null;
      const regionId = best.regionId;
      return {
        d2: best.d2,
        open: () => {
          const region = GPS_WATCH_REGIONS.find((r) => r.id === regionId)!;
          const r = latest.find((x) => x.regionId === regionId);
          ctx.setCard({
            title: region.name.toUpperCase(),
            subtitle: 'GPS integrity',
            rows: [
              {
                label: 'DEGRADED',
                value: r && r.fraction !== null ? `${Math.round(r.fraction * 100)}% of ${r.aircraft} aircraft` : 'no data',
              },
              { label: 'MEANS', value: 'share of aircraft reporting NIC ≤ 4' },
              { label: 'SCALE', value: 'green <15% · amber ~30% · red ≥45%' },
              ...(r ? [{ label: 'SWEPT', value: `${Math.max(0, Math.round(Date.now() / 1000 - r.fetchedAt))}s ago` }] : []),
            ],
          });
        },
      };
    });

    return {
      dispose() {
        clearInterval(timer);
        unregister();
        ctx.scene.remove(group);
        for (const t of tiles) {
          t.mesh.geometry.dispose();
          t.mesh.material.dispose();
        }
      },
    };
  },
};
