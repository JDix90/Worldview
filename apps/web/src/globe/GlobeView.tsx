/**
 * The globe. Interaction tuning is transplanted from Borderfall's
 * GlobeMap.tsx and is the reference feel (FOUNDATION §10): inertial
 * auto-rotate 0.4, paused while the user drives, resumed 2.5s after they
 * stop; globe.gl's distance-scaled orbit/zoom provides the rest.
 *
 * Phase 1.5 additions: mounts furniture layers (layers/registry), drives
 * them from one shared rAF tick, shares the terminator's sun direction, and
 * owns the ONE pointer handler for picking — every layer (aircraft included)
 * registers a Picker and the globally nearest candidate wins the click.
 */
import { useEffect, useRef, useState } from 'react';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import * as THREE from 'three';
import { createTerminatorMaterial } from './terminator';
import { subsolarPoint } from './solar';
import { buildPerfMarkers, perfMarkerCountFromQuery } from './perfMarkers';
import { AircraftLayer } from './AircraftLayer';
import type { AircraftStore } from '../feed/aircraftStore';
import type { LayerCard, LayerCtx, LayerDef, LayerInstance, Picker } from '../layers/registry';

const AUTO_ROTATE_SPEED = 0.4;
const AUTO_ROTATE_RESUME_MS = 2500;
// globe.gl's sphere radius is 100. Inner clamp keeps the country/region zoom
// floor (FOUNDATION: no street level, ever); the outer clamp is the Phase 1.5
// "space band" — 720 puts the GEO ring (~661) comfortably in view.
const MIN_CAMERA_DISTANCE = 115;
const MAX_CAMERA_DISTANCE = 720;
const SUN_UPDATE_MS = 30_000;
/** Max pointer travel for a gesture to count as a click, not a drag. */
const CLICK_SLOP_PX = 6;

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
  layerDefs: LayerDef[];
  layersEnabled: Set<string>;
  setCard: (card: LayerCard | null) => void;
}

export function GlobeView({
  store,
  selectedHex,
  onSelect,
  layerDefs,
  layersEnabled,
  setCard,
}: GlobeViewProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [material, setMaterial] = useState<THREE.ShaderMaterial | null>(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const sunDirRef = useRef(new THREE.Vector3(1, 0, 0));
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const setCardRef = useRef(setCard);
  setCardRef.current = setCard;

  // picking: layers register here; one pointer handler arbitrates
  const pickersRef = useRef(new Map<number, Picker>());
  const nextPickerIdRef = useRef(1);
  const registerPickerRef = useRef((picker: Picker) => {
    const id = nextPickerIdRef.current++;
    pickersRef.current.set(id, picker);
    return () => void pickersRef.current.delete(id);
  });

  const instancesRef = useRef(new Map<string, LayerInstance>());

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
  // Layers share the same vector via ctx.getSunDir.
  useEffect(() => {
    if (!ready || !material) return;
    const update = () => {
      const globe = globeRef.current;
      if (!globe) return;
      const { lat, lng } = subsolarPoint(new Date());
      const p = globe.getCoords(lat, lng, 0);
      sunDirRef.current.set(p.x, p.y, p.z).normalize();
      (material.uniforms.sunDir!.value as THREE.Vector3).copy(sunDirRef.current);
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

  // ── layer mounting: diff enabled set against live instances ─────────
  useEffect(() => {
    if (!ready) return;
    const globe = globeRef.current;
    if (!globe) return;
    const ctx: LayerCtx = {
      globe,
      scene: globe.scene(),
      camera: globe.camera() as THREE.PerspectiveCamera,
      getSunDir: () => sunDirRef.current,
      setCard: (c) => setCardRef.current(c),
      registerPicker: registerPickerRef.current,
    };
    const instances = instancesRef.current;
    for (const def of layerDefs) {
      const want = layersEnabled.has(def.id);
      const have = instances.has(def.id);
      if (want && !have) instances.set(def.id, def.init(ctx));
      else if (!want && have) {
        instances.get(def.id)!.dispose();
        instances.delete(def.id);
      }
    }
  }, [ready, layerDefs, layersEnabled]);

  // dispose everything on unmount
  useEffect(() => {
    const instances = instancesRef.current;
    return () => {
      for (const inst of instances.values()) inst.dispose();
      instances.clear();
    };
  }, []);

  // ── shared tick for all layer instances ──────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const camera = globeRef.current!.camera() as THREE.PerspectiveCamera;
    let raf = 0;
    const loop = () => {
      const nowMs = Date.now();
      const camDist = camera.position.length();
      for (const inst of instancesRef.current.values()) inst.update?.(nowMs, camDist);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  // ── centralized picking ───────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const globe = globeRef.current!;
    const camera = globe.camera() as THREE.PerspectiveCamera;
    const dom = (globe.renderer() as THREE.WebGLRenderer).domElement;
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
      let best: { d2: number; open: () => void } | null = null;
      for (const picker of pickersRef.current.values()) {
        const c = picker(px, py, rect, camera);
        if (c && (!best || c.d2 < best.d2)) best = c;
      }
      if (best) best.open();
      else {
        onSelectRef.current(null);
        setCardRef.current(null);
      }
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
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
          registerPicker={registerPickerRef.current}
        />
      )}
    </>
  );
}
