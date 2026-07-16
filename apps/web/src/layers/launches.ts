/**
 * Upcoming launches — Launch Library 2 (thespacedevs), client-direct (CORS
 * verified 2026-07-16). Pad markers with T-minus cards; anything inside T-1h
 * pulses. Free tier is 15 req/hr → 20-min refresh with a localStorage cache
 * so reloads don't spend quota.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { latLngToWorld } from '../globe/surfaceMath';

const API = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30&hide_recent_previous=true';
const REFRESH_MS = 20 * 60_000;
const CACHE_KEY = 'orrery:ll2';
const PICK_RADIUS_PX = 22;
const MAX_PADS = 40;
/** Only show launches inside this horizon — pads with a launch next month are noise. */
const HORIZON_MS = 7 * 24 * 3600_000;

interface Ll2Launch {
  name?: string;
  net?: string;
  status?: { abbrev?: string; name?: string };
  rocket?: { configuration?: { full_name?: string } };
  pad?: {
    name?: string;
    latitude?: string | number;
    longitude?: string | number;
    location?: { name?: string };
  };
}

interface Launch {
  name: string;
  netMs: number;
  status: string;
  vehicle: string;
  pad: string;
  location: string;
  lat: number;
  lon: number;
}

function tMinus(netMs: number): string {
  const dMs = netMs - Date.now();
  const sign = dMs < 0 ? 'T+' : 'T−';
  const a = Math.abs(dMs);
  const h = Math.floor(a / 3600_000);
  const min = Math.floor((a % 3600_000) / 60_000);
  return h > 48 ? `${sign}${Math.round(h / 24)}d` : `${sign}${h}h ${String(min).padStart(2, '0')}m`;
}

const vertexShader = /* glsl */ `
  attribute float aImminent;
  varying vec2 vUv;
  varying float vImminent;
  void main() {
    vUv = uv;
    vImminent = aImminent;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uPhase;
  varying vec2 vUv;
  varying float vImminent;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    // fixed ring + center dot
    float ring = smoothstep(0.10, 0.02, abs(r - 0.62));
    float dot = smoothstep(0.18, 0.04, r);
    // imminent launches (T-1h) get an expanding pulse
    float pulse = vImminent * smoothstep(0.08, 0.0, abs(r - uPhase)) * (1.0 - uPhase);
    float a = (ring * 0.8 + dot + pulse) ;
    if (a < 0.03) discard;
    vec3 col = mix(vec3(0.31, 0.85, 1.0), vec3(1.0, 0.85, 0.3), vImminent);
    gl_FragColor = vec4(col, min(a, 1.0));
  }
`;

export const launchesLayer: LayerDef = {
  id: 'launches',
  label: 'LAUNCHES',
  defaultOn: true,
  attribution: 'TheSpaceDevs LL2',
  init(ctx: LayerCtx): LayerInstance {
    const geometry = new THREE.CircleGeometry(1, 24);
    const material = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PADS);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const imminentAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PADS), 1);
    geometry.setAttribute('aImminent', imminentAttr);
    ctx.scene.add(mesh);

    let launches: Launch[] = [];
    const positions = new Float32Array(MAX_PADS * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    const scl = new THREE.Vector3(2.2, 2.2, 2.2);

    function rebuild(): void {
      const now = Date.now();
      const visible = launches.filter((l) => l.netMs - now < HORIZON_MS);
      mesh.count = visible.length;
      visible.forEach((l, i) => {
        latLngToWorld(l.lat, l.lon, 0.006, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        q.setFromUnitVectors(up, pos.clone().normalize());
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        imminentAttr.setX(i, l.netMs - now < 3600_000 && l.netMs - now > -1800_000 ? 1 : 0);
      });
      mesh.instanceMatrix.needsUpdate = true;
      imminentAttr.needsUpdate = true;
      // keep the picker index aligned with what's rendered
      renderedLaunches = visible;
    }
    let renderedLaunches: Launch[] = [];

    function parse(results: Ll2Launch[]): Launch[] {
      return results
        .map((l) => {
          const lat = Number(l.pad?.latitude);
          const lon = Number(l.pad?.longitude);
          const netMs = l.net ? Date.parse(l.net) : NaN;
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(netMs)) return null;
          return {
            name: l.name ?? 'Unknown',
            netMs,
            status: l.status?.abbrev ?? '?',
            vehicle: l.rocket?.configuration?.full_name ?? '',
            pad: l.pad?.name ?? '',
            location: l.pad?.location?.name ?? '',
            lat,
            lon,
          };
        })
        .filter((l): l is Launch => l !== null);
    }

    async function refresh(force = false): Promise<void> {
      try {
        if (!force) {
          const raw = localStorage.getItem(CACHE_KEY);
          if (raw) {
            const cached = JSON.parse(raw) as { at: number; results: Ll2Launch[] };
            if (Date.now() - cached.at < REFRESH_MS) {
              launches = parse(cached.results);
              rebuild();
              return;
            }
          }
        }
        const res = await fetch(API);
        if (!res.ok) throw new Error(`LL2 HTTP ${res.status}`);
        const data = (await res.json()) as { results: Ll2Launch[] };
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), results: data.results }));
        } catch { /* quota */ }
        launches = parse(data.results);
        rebuild();
      } catch (err) {
        console.warn('[launches] refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(true), REFRESH_MS);
    // T-minus states (imminent pulse) shift without new data — re-place minutely
    const minutely = setInterval(rebuild, 60_000);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < renderedLaunches.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < 100 * 100) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const l = renderedLaunches[best.i]!;
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: l.name.split('|')[1]?.trim() || l.name,
            subtitle: 'launch',
            rows: [
              ...(l.vehicle ? [{ label: 'VEHICLE', value: l.vehicle }] : []),
              { label: 'NET', value: new Date(l.netMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z' },
              { label: 'COUNT', value: `${tMinus(l.netMs)} (at click)` },
              { label: 'STATUS', value: l.status },
              { label: 'PAD', value: l.pad },
              { label: 'SITE', value: l.location },
            ],
          }),
      };
    });

    return {
      update(nowMs) {
        material.uniforms.uPhase!.value = ((nowMs / 1000) % 2.2) / 2.2;
      },
      dispose() {
        clearInterval(timer);
        clearInterval(minutely);
        unregister();
        ctx.scene.remove(mesh);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
