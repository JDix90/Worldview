/**
 * Live aircraft on the globe: one InstancedMesh, matrices packed by hand each
 * frame (no per-instance Object3D churn — ~10k aircraft must stay far under
 * the frame budget). Orientation = surface tangent frame rotated to the
 * aircraft's track; position = the store's smoothed dead-reckoned fix.
 *
 * Selection is deliberately not a raycast: on click we project every rendered
 * aircraft to screen space and take the nearest within a generous radius —
 * uniformly forgiving at every zoom level (FOUNDATION §10 "forgiving click
 * targets"), with a silhouette test so aircraft behind the globe can't be hit.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GlobeMethods } from 'react-globe.gl';
import type { AircraftStore } from '../feed/aircraftStore';

const MAX_INSTANCES = 20_000;
const GLOBE_RADIUS = 100;
/** World units of clearance above the surface + gentle altitude exaggeration. */
const BASE_CLEARANCE = 0.5;
const ALT_EXAGGERATION = 3;
const EARTH_RADIUS_M = 6_371_000;
/** Marker scale vs camera distance (constant-ish apparent size). */
const SCALE_DIST_REF = 280;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.8;
/** Forgiving click radius, CSS pixels. */
const PICK_RADIUS_PX = 18;
/** Max pointer travel for a gesture to count as a click, not a drag. */
const CLICK_SLOP_PX = 6;

const DEG = Math.PI / 180;
const MARKER_COLOR = 0xffb300;
const HALO_COLOR = 0x4fd8ff;

interface Props {
  globe: GlobeMethods;
  store: AircraftStore;
  selectedHex: string | null;
  onSelect: (hex: string | null) => void;
}

export function AircraftLayer({ globe, store, selectedHex, onSelect }: Props) {
  const selectedRef = useRef(selectedHex);
  selectedRef.current = selectedHex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const scene = globe.scene();
    const camera = globe.camera() as THREE.PerspectiveCamera;
    const renderer = globe.renderer() as THREE.WebGLRenderer;

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
        writeMatrix(matrices, i, pos, lat, lon, trackDeg, s);
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

    // ── selection ──────────────────────────────────────────────────────
    const dom = renderer.domElement;
    let downX = 0;
    let downY = 0;
    const onDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
    };
    const onUp = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > CLICK_SLOP_PX) return; // drag
      const rect = dom.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const r2 = GLOBE_RADIUS * GLOBE_RADIUS;
      let bestHex: string | null = null;
      let bestD2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
      for (let i = 0; i < activeCount; i++) {
        proj.fromArray(positions, i * 3);
        // silhouette-plane test: skip aircraft on the far side of the globe
        if (proj.dot(camera.position) < r2) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
        if (d2 < bestD2) {
          bestD2 = d2;
          bestHex = idxToHex[i]!;
        }
      }
      onSelectRef.current(bestHex);
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
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

/** three-globe's polar→cartesian convention (verified against getCoords at mount). */
function latLngToWorld(lat: number, lng: number, altUnits: number, out: THREE.Vector3): THREE.Vector3 {
  const r = GLOBE_RADIUS * (1 + altUnits);
  const phi = (90 - lat) * DEG;
  const theta = (90 - lng) * DEG;
  const sinPhi = Math.sin(phi);
  return out.set(r * sinPhi * Math.cos(theta), r * Math.cos(phi), r * sinPhi * Math.sin(theta));
}

/**
 * Pack a TRS matrix directly into the instance buffer: basis Y = surface
 * normal, Z = track direction (geometry nose), X = their cross product.
 * All three are exactly orthonormal by construction — no normalization pass.
 */
function writeMatrix(
  out: Float32Array,
  i: number,
  pos: THREE.Vector3,
  lat: number,
  lon: number,
  trackDeg: number,
  scale: number,
): void {
  const len = pos.length();
  const nx = pos.x / len;
  const ny = pos.y / len;
  const nz = pos.z / len;

  // east/north tangent frame (degenerate at the exact poles; collector data
  // there is effectively nonexistent)
  const eLen = Math.hypot(nz, nx) || 1e-9;
  const ex = nz / eLen;
  const ez = -nx / eLen;
  // north = n × east
  const nox = -ny * ez;
  const noy = nz * ez - nx * ex;
  const noz = ny * ex;

  const tr = trackDeg * DEG;
  const st = Math.sin(tr);
  const ct = Math.cos(tr);
  // forward (Z axis) = east*sin(track) + north*cos(track)
  const fx = ex * st + nox * ct;
  const fy = noy * ct;
  const fz = ez * st + noz * ct;
  // X axis = n × forward
  const xx = ny * fz - nz * fy;
  const xy = nz * fx - nx * fz;
  const xz = nx * fy - ny * fx;

  const o = i * 16;
  out[o] = xx * scale;      out[o + 1] = xy * scale;  out[o + 2] = xz * scale;  out[o + 3] = 0;
  out[o + 4] = nx * scale;  out[o + 5] = ny * scale;  out[o + 6] = nz * scale;  out[o + 7] = 0;
  out[o + 8] = fx * scale;  out[o + 9] = fy * scale;  out[o + 10] = fz * scale; out[o + 11] = 0;
  out[o + 12] = pos.x;      out[o + 13] = pos.y;      out[o + 14] = pos.z;      out[o + 15] = 1;
}
