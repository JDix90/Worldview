/**
 * Tropical cyclones — NOAA NHC active storms via the server proxy (NHC sends
 * no CORS headers; verified 2026-07-16). Slow-pulsing discs scaled and
 * colored by classification, detail card with winds/pressure/movement.
 * Coverage: Atlantic / East+Central Pacific (NHC's basins) — WPac/JTWC is a
 * documented v1 gap.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { apiGet } from '../feed/api';
import { latLngToWorld } from '../globe/surfaceMath';
import { agoShort, compass16, ktMph, latLon, utcShort } from '../format';

/** Plain-language read of storm strength (Saffir-Simpson from sustained kt). */
function stormNote(classification: string, windsKt: number): string {
  if (classification === 'TD') return 'Tropical depression — winds under 39 mph.';
  if (classification === 'TS') return 'Tropical storm — sustained 39–73 mph.';
  const mph = windsKt * 1.15078;
  if (mph < 96) return 'Category 1 hurricane — some damage to homes and trees.';
  if (mph < 111) return 'Category 2 hurricane — extensive damage, widespread power loss.';
  if (mph < 130) return 'Category 3 hurricane — devastating damage (major).';
  if (mph < 157) return 'Category 4 hurricane — catastrophic damage.';
  return 'Category 5 hurricane — catastrophic; areas uninhabitable for weeks.';
}

/** NHC advisory timestamps parse cleanly; show relative + UTC, raw as fallback. */
function advisoryAge(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? `${agoShort(ms)} · ${utcShort(ms)}` : raw;
}

const REFRESH_MS = 15 * 60_000;
const PICK_RADIUS_PX = 26;
const PULSE_PERIOD_S = 5;
const MAX_STORMS = 32;

interface NhcStorm {
  name?: string;
  classification?: string;
  intensity?: string | number;
  pressure?: string | number;
  latitudeNumeric?: number;
  longitudeNumeric?: number;
  movementDir?: number;
  movementSpeed?: number;
  lastUpdate?: string;
}

interface Storm {
  name: string;
  classification: string;
  windsKt: number;
  pressureMb: number | null;
  lat: number;
  lon: number;
  movementDir: number | null;
  movementSpeed: number | null;
  lastUpdate: string | null;
}

const CLASS_NAMES: Record<string, string> = {
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  HU: 'Hurricane',
  MH: 'Major Hurricane',
  STD: 'Subtropical Depression',
  STS: 'Subtropical Storm',
  PTC: 'Post-tropical Cyclone',
  PC: 'Potential Tropical Cyclone',
};

/** Saffir-Simpson-ish visual scale from sustained winds (kt). */
function stormScale(windsKt: number): number {
  if (windsKt >= 137) return 9;   // cat 5
  if (windsKt >= 113) return 7.5; // cat 4
  if (windsKt >= 96) return 6.5;  // cat 3
  if (windsKt >= 83) return 5.5;  // cat 2
  if (windsKt >= 64) return 4.8;  // cat 1
  if (windsKt >= 34) return 3.6;  // TS
  return 2.6;                     // TD
}

function stormColor(windsKt: number): [number, number, number] {
  if (windsKt >= 96) return [1.0, 0.15, 0.25]; // major — red
  if (windsKt >= 64) return [1.0, 0.4, 0.15];  // hurricane — orange-red
  if (windsKt >= 34) return [1.0, 0.7, 0.2];   // TS — amber
  return [0.6, 0.75, 0.9];                     // TD — pale blue
}

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

// eye dot + two slow expanding rings — reads as "rotating system" without
// per-storm geometry
const fragmentShader = /* glsl */ `
  uniform float uPhase;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float eye = smoothstep(0.16, 0.02, r) * 0.95;
    float ring1 = smoothstep(0.07, 0.0, abs(r - uPhase)) * (1.0 - uPhase);
    float p2 = fract(uPhase + 0.5);
    float ring2 = smoothstep(0.07, 0.0, abs(r - p2)) * (1.0 - p2);
    float halo = smoothstep(1.0, 0.2, r) * 0.12;
    float a = eye + (ring1 + ring2) * 0.7 + halo;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export const cyclonesLayer: LayerDef = {
  id: 'cyclones',
  label: 'CYCLONES',
  defaultOn: true,
  attribution: 'NOAA NHC',
  init(ctx: LayerCtx): LayerInstance {
    const geometry = new THREE.CircleGeometry(1, 32);
    const material = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_STORMS);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STORMS * 3), 3);
    geometry.setAttribute('aColor', colorAttr);
    ctx.scene.add(mesh);

    let storms: Storm[] = [];
    const positions = new Float32Array(MAX_STORMS * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    const scl = new THREE.Vector3();

    function rebuild(): void {
      mesh.count = storms.length;
      storms.forEach((s, i) => {
        latLngToWorld(s.lat, s.lon, 0.008, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        q.setFromUnitVectors(up, pos.clone().normalize());
        const sc = stormScale(s.windsKt);
        scl.set(sc, sc, sc);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        const [r, g, b] = stormColor(s.windsKt);
        colorAttr.setXYZ(i, r, g, b);
      });
      mesh.instanceMatrix.needsUpdate = true;
      colorAttr.needsUpdate = true;
    }

    async function refresh(): Promise<void> {
      try {
        const data = await apiGet<{ activeStorms?: NhcStorm[] }>('/api/proxy/storms');
        storms = (data.activeStorms ?? [])
          .filter((s) => typeof s.latitudeNumeric === 'number' && typeof s.longitudeNumeric === 'number')
          .slice(0, MAX_STORMS)
          .map((s) => ({
            name: s.name ?? 'UNNAMED',
            classification: s.classification ?? '?',
            windsKt: Number(s.intensity) || 0,
            pressureMb: s.pressure !== undefined && s.pressure !== null ? Number(s.pressure) : null,
            lat: s.latitudeNumeric!,
            lon: s.longitudeNumeric!,
            movementDir: typeof s.movementDir === 'number' ? s.movementDir : null,
            movementSpeed: typeof s.movementSpeed === 'number' ? s.movementSpeed : null,
            lastUpdate: s.lastUpdate ?? null,
          }));
        rebuild();
      } catch (err) {
        console.warn('[cyclones] refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < storms.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < 100 * 100) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const s = storms[best.i]!;
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: s.name.toUpperCase(),
            subtitle: CLASS_NAMES[s.classification] ?? s.classification,
            note: stormNote(s.classification, s.windsKt),
            rows: [
              { label: 'WINDS', value: `${ktMph(s.windsKt)} sustained` },
              ...(s.pressureMb
                ? [{ label: 'PRESSURE', value: `${s.pressureMb} mb (lower = stronger)` }]
                : []),
              ...(s.movementDir !== null
                ? [
                    {
                      label: 'MOVING',
                      value: `${compass16(s.movementDir)} at ${s.movementSpeed ?? '?'} kt`,
                    },
                  ]
                : []),
              { label: 'POSITION', value: latLon(s.lat, s.lon, 1) },
              ...(s.lastUpdate
                ? [{ label: 'ADVISORY', value: advisoryAge(s.lastUpdate) }]
                : []),
            ],
          }),
      };
    });

    return {
      update(nowMs) {
        material.uniforms.uPhase!.value = ((nowMs / 1000) % PULSE_PERIOD_S) / PULSE_PERIOD_S;
      },
      dispose() {
        clearInterval(timer);
        unregister();
        ctx.scene.remove(mesh);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
