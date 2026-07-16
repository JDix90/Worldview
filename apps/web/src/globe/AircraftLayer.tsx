/**
 * Live aircraft on the globe: one InstancedMesh, matrices packed by hand each
 * frame (no per-instance Object3D churn — ~10k aircraft must stay far under
 * the frame budget). Orientation = surface tangent frame rotated to the
 * aircraft's track; position = the store's smoothed dead-reckoned fix.
 *
 * Selection is deliberately not a raycast: the layer registers a Picker with
 * GlobeView's central pointer handler — projecting every rendered aircraft to
 * screen space and offering the nearest within a generous radius — uniformly
 * forgiving at every zoom level (FOUNDATION §10 "forgiving click targets"),
 * with a silhouette test so aircraft behind the globe can't be hit.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GlobeMethods } from 'react-globe.gl';
import type { AircraftStore } from '../feed/aircraftStore';
import type { Picker } from '../layers/registry';
import { latLngToWorld, writeHeadingMatrix, GLOBE_RADIUS, EARTH_RADIUS_M } from './surfaceMath';

const MAX_INSTANCES = 20_000;
/** World units of clearance above the surface + gentle altitude exaggeration. */
const BASE_CLEARANCE = 0.5;
const ALT_EXAGGERATION = 3;
/** Marker scale vs camera distance (constant-ish apparent size). */
const SCALE_DIST_REF = 280;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.8;
/** Forgiving click radius, CSS pixels. */
const PICK_RADIUS_PX = 18;

const MARKER_COLOR = 0xffb300;
const HALO_COLOR = 0x4fd8ff;

interface Props {
  globe: GlobeMethods;
  store: AircraftStore;
  selectedHex: string | null;
  onSelect: (hex: string | null) => void;
  registerPicker: (picker: Picker) => () => void;
}

export function AircraftLayer({ globe, store, selectedHex, onSelect, registerPicker }: Props) {
  const selectedRef = useRef(selectedHex);
  selectedRef.current = selectedHex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const scene = globe.scene();
    const camera = globe.camera() as THREE.PerspectiveCamera;

    // sanity-check our inlined lat/lng→world convention against globe.gl's own
    const probe = globe.getCoords(37, -122, 0);
    const check = latLngToWorld(37, -122, 0, new THREE.Vector3());
    if (check.distanceTo(new THREE.Vector3(probe.x, probe.y, probe.z)) > 0.01) {
      console.warn('AircraftLayer: coordinate convention drifted from globe.gl', probe, check);
    }

    const geometry = new THREE.ConeGeometry(0.38, 1.6, 4);
    geometry.rotateX(Math.PI / 2); // nose points +Z; matrix basis Z = track direction
    const material = new THREE.MeshBasicMaterial({ color: MARKER_COLOR });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES);
    mesh.frustumCulled = false; // matrices span the whole globe; culling sphere is wrong
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.1, 32),
      new THREE.MeshBasicMaterial({ color: HALO_COLOR, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    halo.visible = false;
    scene.add(halo);

    // per-frame scratch state (allocated once)
    const idxToHex: string[] = new Array(MAX_INSTANCES);
    const positions = new Float32Array(MAX_INSTANCES * 3);
    let activeCount = 0;
    const pos = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const haloPos = new THREE.Vector3();

    let raf = 0;
    let lastT = performance.now();
    const matrices = mesh.instanceMatrix.array as Float32Array;

    const loop = (t: number) => {
      const dtS = Math.min((t - lastT) / 1000, 0.25);
      lastT = t;
      const camDist = camera.position.length();
      const s = Math.min(Math.max(camDist / SCALE_DIST_REF, SCALE_MIN), SCALE_MAX);

      let selectedIdx = -1;
      activeCount = store.frame(dtS, (i, hex, lat, lon, altM, trackDeg) => {
        if (i >= MAX_INSTANCES) return;
        idxToHex[i] = hex;
        const altUnits = BASE_CLEARANCE / GLOBE_RADIUS + (altM / EARTH_RADIUS_M) * ALT_EXAGGERATION;
        latLngToWorld(lat, lon, altUnits, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        writeHeadingMatrix(matrices, i, pos, trackDeg, s);
        if (hex === selectedRef.current) selectedIdx = i;
      });
      mesh.count = activeCount;
      mesh.instanceMatrix.needsUpdate = true;

      if (selectedIdx >= 0) {
        haloPos.fromArray(positions, selectedIdx * 3);
        halo.position.copy(haloPos);
        halo.lookAt(haloPos.x * 2, haloPos.y * 2, haloPos.z * 2); // ring flat on surface
        const pulse = s * (1 + 0.15 * Math.sin(t / 250));
        halo.scale.setScalar(pulse);
        halo.visible = true;
      } else {
        halo.visible = false;
        if (selectedRef.current !== null && activeCount > 0) {
          // selected aircraft left the store (purged) — clear the selection
          onSelectRef.current(null);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // ── selection: offer the nearest aircraft to the central picker ────
    const unregister = registerPicker((px, py, rect, cam) => {
      const r2 = GLOBE_RADIUS * GLOBE_RADIUS;
      let bestHex: string | null = null;
      let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
      for (let i = 0; i < activeCount; i++) {
        proj.fromArray(positions, i * 3);
        // silhouette-plane test: skip aircraft on the far side of the globe
        if (proj.dot(cam.position) < r2) continue;
        proj.project(cam);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
        if (d2 < bestD2) {
          bestD2 = d2;
          bestHex = idxToHex[i]!;
        }
      }
      if (bestHex === null) return null;
      const hex = bestHex;
      return { d2: bestD2, open: () => onSelectRef.current(hex) };
    });

    return () => {
      cancelAnimationFrame(raf);
      unregister();
      scene.remove(mesh);
      scene.remove(halo);
      geometry.dispose();
      material.dispose();
      halo.geometry.dispose();
      (halo.material as THREE.Material).dispose();
    };
  }, [globe, store]);

  return null;
}
