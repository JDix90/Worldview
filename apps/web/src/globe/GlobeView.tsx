/**
 * The globe. Interaction tuning is transplanted from Borderfall's
 * GlobeMap.tsx and is the reference feel (FOUNDATION §10): inertial
 * auto-rotate 0.4, paused while the user drives, resumed 2.5s after they
 * stop; globe.gl's distance-scaled orbit/zoom provides the rest.
 */
import { useEffect, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import type * as THREE from 'three';
import { createTerminatorMaterial } from './terminator';
import { subsolarPoint } from './solar';
import { buildPerfMarkers, perfMarkerCountFromQuery } from './perfMarkers';
import { AircraftLayer } from './AircraftLayer';
import type { AircraftStore } from '../feed/aircraftStore';

const AUTO_ROTATE_SPEED = 0.4;
const AUTO_ROTATE_RESUME_MS = 2500;
// globe.gl's sphere radius is 100; distances clamp zoom to ~country/region
// scale (FOUNDATION: no street level, ever)
const MIN_CAMERA_DISTANCE = 115;
const MAX_CAMERA_DISTANCE = 480;
const SUN_UPDATE_MS = 30_000;

type GlobeControls = {
  autoRotate: boolean;
  autoRotateSpeed: number;
  minDistance: number;
  maxDistance: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

interface GlobeViewProps {
  store: AircraftStore;
  selectedHex: string | null;
  onSelect: (hex: string | null) => void;
}

export function GlobeView({ store, selectedHex, onSelect }: GlobeViewProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [material, setMaterial] = useState<THREE.ShaderMaterial | null>(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    let cancelled = false;
    void createTerminatorMaterial().then((m) => {
      if (!cancelled) setMaterial(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Sun direction: subsolar point mapped through the globe's own coordinate
  // convention (getCoords), so the terminator can't drift from the texture.
  useEffect(() => {
    if (!ready || !material) return;
    const update = () => {
      const globe = globeRef.current;
      if (!globe) return;
      const { lat, lng } = subsolarPoint(new Date());
      const p = globe.getCoords(lat, lng, 0);
      (material.uniforms.sunDir!.value as THREE.Vector3).set(p.x, p.y, p.z).normalize();
    };
    update();
    const id = setInterval(update, SUN_UPDATE_MS);
    return () => clearInterval(id);
  }, [ready, material]);

  // Borderfall interaction tuning.
  useEffect(() => {
    if (!ready) return;
    const ctrl = globeRef.current?.controls() as GlobeControls | undefined;
    if (!ctrl) return;
    ctrl.autoRotate = true;
    ctrl.autoRotateSpeed = AUTO_ROTATE_SPEED;
    ctrl.minDistance = MIN_CAMERA_DISTANCE;
    ctrl.maxDistance = MAX_CAMERA_DISTANCE;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onStart = () => {
      clearTimeout(timer);
      ctrl.autoRotate = false;
    };
    const onEnd = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        ctrl.autoRotate = true;
      }, AUTO_ROTATE_RESUME_MS);
    };
    ctrl.addEventListener('start', onStart);
    ctrl.addEventListener('end', onEnd);
    return () => {
      clearTimeout(timer);
      ctrl.removeEventListener('start', onStart);
      ctrl.removeEventListener('end', onEnd);
    };
  }, [ready]);

  // Optional perf harness (?perf=12000).
  useEffect(() => {
    if (!ready) return;
    const count = perfMarkerCountFromQuery(window.location.search);
    const globe = globeRef.current;
    if (!count || !globe) return;
    const markers = buildPerfMarkers(globe, count);
    globe.scene().add(markers);
    return () => {
      globe.scene().remove(markers);
      markers.geometry.dispose();
      (markers.material as THREE.Material).dispose();
    };
  }, [ready]);

  if (!material) return null;

  return (
    <>
      <Globe
        ref={globeRef}
        width={size.w}
        height={size.h}
        backgroundColor="#000004"
        globeMaterial={material}
        showAtmosphere
        atmosphereAltitude={0.13}
        onGlobeReady={() => {
          globeRef.current?.pointOfView({ lat: 24, lng: -35, altitude: 2.3 }, 0);
          // dev/verification handle (camera driving, forced-render timing)
          (window as { __ORRERY__?: unknown }).__ORRERY__ = { globe: globeRef.current, store };
          setReady(true);
        }}
      />
      {ready && globeRef.current && (
        <AircraftLayer
          globe={globeRef.current}
          store={store}
          selectedHex={selectedHex}
          onSelect={onSelect}
        />
      )}
    </>
  );
}
