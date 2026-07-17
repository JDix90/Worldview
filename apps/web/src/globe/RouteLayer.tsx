/**
 * Flight-path overlay for the selected aircraft. Draws two great-circle
 * segments as tube ribbons — departure→aircraft (flown, dim) and
 * aircraft→destination (ahead, bright) — plus a dot at each airport. Tubes,
 * not 1px lines: the path is an on-demand feature and must read clearly at
 * any zoom. Mounted by GlobeView only while the user has toggled the route on
 * from the aircraft card; the route comes from the shared per-callsign cache.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GlobeMethods } from 'react-globe.gl';
import type { AircraftStore } from '../feed/aircraftStore';
import { fetchRoute, type FlightRoute } from '../feed/routes';
import { latLngToWorld } from './surfaceMath';

const ARC_ALT = (100.4 - 100) / 100; // above borders (100.15), below aircraft markers
const TUBE_RADIUS = 0.22;
const STEPS = 96;
const REBUILD_MS = 500; // aircraft moves slowly; no need to rebuild every frame
const FLOWN_COLOR = 0x3f8fb0;
const AHEAD_COLOR = 0x4fd8ff;
const ORIGIN_COLOR = 0x8fe36b;
const DEST_COLOR = 0xffb300;

/** Unit-sphere-slerped great-circle points between two lat/lon. */
function greatCirclePoints(latA: number, lonA: number, latB: number, lonB: number): THREE.Vector3[] {
  const a = latLngToWorld(latA, lonA, ARC_ALT, new THREE.Vector3());
  const b = latLngToWorld(latB, lonB, ARC_ALT, new THREE.Vector3());
  const radius = a.length();
  const pa = a.clone().normalize();
  const pb = b.clone().normalize();
  const angle = pa.angleTo(pb);
  const n = Math.max(2, Math.ceil((angle / Math.PI) * STEPS));
  const sinA = Math.sin(angle) || 1;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w1 = angle < 1e-6 ? 1 - t : Math.sin((1 - t) * angle) / sinA;
    const w2 = angle < 1e-6 ? t : Math.sin(t * angle) / sinA;
    pts.push(new THREE.Vector3(
      (pa.x * w1 + pb.x * w2) * radius,
      (pa.y * w1 + pb.y * w2) * radius,
      (pa.z * w1 + pb.z * w2) * radius,
    ));
  }
  return pts;
}

function tubeGeometry(pts: THREE.Vector3[]): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, Math.max(2, pts.length), TUBE_RADIUS, 6, false);
}

function dot(color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 14, 14),
    new THREE.MeshBasicMaterial({ color }),
  );
  m.renderOrder = 2;
  return m;
}

interface Props {
  globe: GlobeMethods;
  store: AircraftStore;
  hex: string;
}

export function RouteLayer({ globe, store, hex }: Props): null {
  const hexRef = useRef(hex);
  hexRef.current = hex;

  useEffect(() => {
    const scene = globe.scene();
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);

    const flownMat = new THREE.MeshBasicMaterial({ color: FLOWN_COLOR, transparent: true, opacity: 0.65 });
    const aheadMat = new THREE.MeshBasicMaterial({ color: AHEAD_COLOR, transparent: true, opacity: 0.9 });
    const flown = new THREE.Mesh(undefined, flownMat);
    const ahead = new THREE.Mesh(undefined, aheadMat);
    flown.frustumCulled = false;
    ahead.frustumCulled = false;
    const originDot = dot(ORIGIN_COLOR);
    const destDot = dot(DEST_COLOR);
    group.add(flown, ahead, originDot, destDot);

    let route: FlightRoute | null = null;
    let cancelled = false;
    const cs = store.byHex.get(hex)?.state.callsign;
    void fetchRoute(cs).then((r) => {
      if (cancelled || !r) return;
      route = r;
      latLngToWorld(r.origin.lat, r.origin.lon, ARC_ALT, originDot.position);
      latLngToWorld(r.destination.lat, r.destination.lon, ARC_ALT, destDot.position);
      group.visible = true;
    });

    let raf = 0;
    let lastBuild = -Infinity;
    const rebuild = () => {
      if (!route) return;
      const t = store.byHex.get(hexRef.current);
      if (!t) return; // aircraft purged — freeze the last arc
      flown.geometry?.dispose();
      ahead.geometry?.dispose();
      flown.geometry = tubeGeometry(greatCirclePoints(route.origin.lat, route.origin.lon, t.renderLat, t.renderLon));
      ahead.geometry = tubeGeometry(greatCirclePoints(t.renderLat, t.renderLon, route.destination.lat, route.destination.lon));
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastBuild >= REBUILD_MS) {
        lastBuild = now;
        rebuild();
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      scene.remove(group);
      flown.geometry?.dispose();
      ahead.geometry?.dispose();
      flownMat.dispose();
      aheadMat.dispose();
      originDot.geometry.dispose();
      (originDot.material as THREE.Material).dispose();
      destDot.geometry.dispose();
      (destDot.material as THREE.Material).dispose();
    };
  }, [globe, store, hex]);

  return null;
}
