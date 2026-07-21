/**
 * Airport delays — FAA national airspace status via the server proxy
 * (nasstatus XML isn't CORS-open; parsed server-side to JSON). Marks ONLY
 * airports with active programs — a good day is an empty layer. Amber pulse =
 * delay program, red = ground stop / closure. "Why is the flight late?" is a
 * living-room question; this is its layer.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { latLngToWorld } from '../globe/surfaceMath';
import { apiGet } from '../feed/api';

const REFRESH_MS = 3 * 60_000;
const MAX_MARKS = 64;
const PICK_RADIUS_PX = 16;
const PULSE_PERIOD_S = 2;

/** Major US airports (hand-curated public facts: IATA, name, lat, lon). */
const AIRPORTS: Record<string, { name: string; lat: number; lon: number }> = {
  ATL: { name: 'Atlanta Hartsfield–Jackson', lat: 33.64, lon: -84.43 },
  LAX: { name: 'Los Angeles Intl', lat: 33.94, lon: -118.41 },
  ORD: { name: "Chicago O'Hare", lat: 41.98, lon: -87.90 },
  DFW: { name: 'Dallas/Fort Worth', lat: 32.90, lon: -97.04 },
  DEN: { name: 'Denver Intl', lat: 39.86, lon: -104.67 },
  JFK: { name: 'New York JFK', lat: 40.64, lon: -73.78 },
  SFO: { name: 'San Francisco Intl', lat: 37.62, lon: -122.38 },
  SEA: { name: 'Seattle–Tacoma', lat: 47.45, lon: -122.31 },
  LAS: { name: 'Las Vegas Harry Reid', lat: 36.08, lon: -115.15 },
  MCO: { name: 'Orlando Intl', lat: 28.43, lon: -81.31 },
  EWR: { name: 'Newark Liberty', lat: 40.69, lon: -74.17 },
  CLT: { name: 'Charlotte Douglas', lat: 35.21, lon: -80.94 },
  PHX: { name: 'Phoenix Sky Harbor', lat: 33.44, lon: -112.01 },
  IAH: { name: 'Houston Bush', lat: 29.98, lon: -95.34 },
  MIA: { name: 'Miami Intl', lat: 25.79, lon: -80.29 },
  BOS: { name: 'Boston Logan', lat: 42.36, lon: -71.01 },
  MSP: { name: 'Minneapolis–St. Paul', lat: 44.88, lon: -93.22 },
  FLL: { name: 'Fort Lauderdale', lat: 26.07, lon: -80.15 },
  DTW: { name: 'Detroit Metro', lat: 42.21, lon: -83.35 },
  PHL: { name: 'Philadelphia Intl', lat: 39.87, lon: -75.24 },
  LGA: { name: 'New York LaGuardia', lat: 40.78, lon: -73.87 },
  BWI: { name: 'Baltimore/Washington', lat: 39.18, lon: -76.67 },
  SLC: { name: 'Salt Lake City', lat: 40.79, lon: -111.98 },
  DCA: { name: 'Washington National', lat: 38.85, lon: -77.04 },
  IAD: { name: 'Washington Dulles', lat: 38.95, lon: -77.46 },
  SAN: { name: 'San Diego Intl', lat: 32.73, lon: -117.19 },
  TPA: { name: 'Tampa Intl', lat: 27.98, lon: -82.53 },
  AUS: { name: 'Austin–Bergstrom', lat: 30.19, lon: -97.67 },
  BNA: { name: 'Nashville Intl', lat: 36.13, lon: -86.67 },
  MDW: { name: 'Chicago Midway', lat: 41.79, lon: -87.75 },
  HNL: { name: 'Honolulu Inouye', lat: 21.32, lon: -157.92 },
  PDX: { name: 'Portland Intl', lat: 45.59, lon: -122.60 },
  STL: { name: 'St. Louis Lambert', lat: 38.75, lon: -90.37 },
  RDU: { name: 'Raleigh–Durham', lat: 35.88, lon: -78.79 },
  SJC: { name: 'San Jose Mineta', lat: 37.36, lon: -121.93 },
  SNA: { name: 'Orange County John Wayne', lat: 33.68, lon: -117.87 },
  OAK: { name: 'Oakland Intl', lat: 37.72, lon: -122.22 },
  MSY: { name: 'New Orleans Armstrong', lat: 29.99, lon: -90.26 },
  SMF: { name: 'Sacramento Intl', lat: 38.70, lon: -121.59 },
  SAT: { name: 'San Antonio Intl', lat: 29.53, lon: -98.47 },
  PIT: { name: 'Pittsburgh Intl', lat: 40.49, lon: -80.23 },
  CLE: { name: 'Cleveland Hopkins', lat: 41.41, lon: -81.85 },
  CVG: { name: 'Cincinnati/N. Kentucky', lat: 39.05, lon: -84.66 },
  PVD: { name: 'Providence T.F. Green', lat: 41.73, lon: -71.43 },
  ANC: { name: 'Anchorage Ted Stevens', lat: 61.17, lon: -149.99 },
};

const TYPE_WORDS: Record<string, string> = {
  closure: 'airport closed',
  'ground-stop': 'ground stop',
  'ground-delay': 'ground delay program',
  delay: 'arrival/departure delays',
};

interface Program {
  arpt: string;
  type: string;
  reason: string;
  detail: string;
}

const vertexShader = /* glsl */ `
  attribute float aRed;
  varying vec2 vUv;
  varying float vRed;
  void main() {
    vUv = uv;
    vRed = aRed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uPhase;
  varying vec2 vUv;
  varying float vRed;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.10, 0.0, abs(r - 0.62));
    float pulse = smoothstep(0.10, 0.0, abs(r - uPhase)) * (1.0 - uPhase) * 0.8;
    float core = smoothstep(0.18, 0.0, r) * 0.9;
    float a = max(max(ring * 0.9, pulse), core);
    if (a < 0.03) discard;
    vec3 amber = vec3(1.0, 0.70, 0.0);
    vec3 red = vec3(1.0, 0.35, 0.35);
    gl_FragColor = vec4(mix(amber, red, vRed), a);
  }
`;

export const airportDelaysLayer: LayerDef = {
  id: 'airports',
  label: 'AIRPORT DELAYS',
  defaultOn: true,
  attribution: 'FAA',
  init(ctx: LayerCtx): LayerInstance {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_MARKS);
    mesh.frustumCulled = false;
    const redAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS), 1);
    geometry.setAttribute('aRed', redAttr);
    mesh.count = 0;
    ctx.scene.add(mesh);

    // one mark per airport (worst program wins), only for known coords
    let marks: Array<{ code: string; programs: Program[] }> = [];
    const positions = new Float32Array(MAX_MARKS * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    const scale = new THREE.Vector3(2.2, 2.2, 2.2);

    const RANK: Record<string, number> = { closure: 3, 'ground-stop': 2, 'ground-delay': 1, delay: 0 };
    const isRed = (t: string) => t === 'closure' || t === 'ground-stop';

    function rebuild(): void {
      mesh.count = marks.length;
      marks.forEach((mk, i) => {
        const ap = AIRPORTS[mk.code]!;
        latLngToWorld(ap.lat, ap.lon, 0.008, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        q.setFromUnitVectors(up, pos.clone().normalize());
        m.compose(pos, q, scale);
        mesh.setMatrixAt(i, m);
        redAttr.array[i] = mk.programs.some((p) => isRed(p.type)) ? 1 : 0;
      });
      mesh.instanceMatrix.needsUpdate = true;
      redAttr.needsUpdate = true;
    }

    async function refresh(): Promise<void> {
      try {
        const d = await apiGet<{ updated: string; programs: Program[] }>('/api/proxy/faa-status');
        const byArpt = new Map<string, Program[]>();
        for (const p of d.programs) {
          if (!AIRPORTS[p.arpt]) continue; // minor fields aren't on the map
          (byArpt.get(p.arpt) ?? byArpt.set(p.arpt, []).get(p.arpt)!).push(p);
        }
        marks = [...byArpt.entries()]
          .map(([code, programs]) => ({
            code,
            programs: programs.sort((a, b) => (RANK[b.type] ?? 0) - (RANK[a.type] ?? 0)),
          }))
          .slice(0, MAX_MARKS);
        rebuild();
      } catch (err) {
        console.warn('[airports] FAA status refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      const r2 = 100 * 100;
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < marks.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < r2) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const mk = marks[best.i]!;
      const ap = AIRPORTS[mk.code]!;
      const worst = mk.programs[0]!;
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: mk.code,
            subtitle: ap.name,
            note: `FAA ${TYPE_WORDS[worst.type] ?? worst.type}${worst.reason ? ` — ${worst.reason.toLowerCase()}` : ''}.`,
            rows: mk.programs.map((p) => ({
              label: (TYPE_WORDS[p.type] ?? p.type).toUpperCase().slice(0, 12),
              value: [p.detail, p.reason].filter(Boolean).join(' — ') || 'active',
            })),
            href: 'https://nasstatus.faa.gov/',
            fly: { lat: ap.lat, lng: ap.lon },
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
