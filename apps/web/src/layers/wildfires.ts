/**
 * Wildfires — NASA FIRMS VIIRS active-fire detections, last 24h, global.
 * Tries client-direct first (key via __FIRMS_KEY__ define); if FIRMS blocks
 * browser origins, falls back automatically to the server proxy
 * (/api/proxy/fires, which reads FIRMS_MAP_KEY from the worker env).
 * Fire season means 10-40k detections — instanced flickering embers,
 * color/size by fire radiative power.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { apiGet } from '../feed/api';
import { latLngToWorld } from '../globe/surfaceMath';
import { agoShort, latLon, utcShort } from '../format';

/** FIRMS 'satellite' column → spacecraft name. */
const SAT_NAMES: Record<string, string> = {
  N20: 'NOAA-20 (VIIRS)',
  '1': 'NOAA-20 (VIIRS)',
  N: 'Suomi NPP (VIIRS)',
  N21: 'NOAA-21 (VIIRS)',
};

const REFRESH_MS = 30 * 60_000;
/**
 * Render cap. World/1-day in fire season is ~95k VIIRS detections; that many
 * additively-blended discs overdraw badly in dense regions (Siberia, boreal
 * Canada). We keep the highest-FRP detections — the visually meaningful
 * fires — and drop the low-power tail. NOAA-20, because Suomi-NPP's NRT feed
 * is deprecated and returns zero rows (verified live 2026-07-16).
 */
const MAX_FIRES = 50_000;
const FIRMS_SOURCE = 'VIIRS_NOAA20_NRT';
const PICK_RADIUS_PX = 14;

interface Fire {
  lat: number;
  lon: number;
  frp: number;        // fire radiative power, MW
  confidence: string; // l | n | h
  acquired: string;   // "2026-07-16 04:12"
  sensor: string;
}

function parseCsv(csv: string): Fire[] {
  const lines = csv.split('\n');
  const header = lines[0]?.split(',') ?? [];
  const col = (name: string) => header.indexOf(name);
  const iLat = col('latitude'), iLon = col('longitude'), iFrp = col('frp'),
    iConf = col('confidence'), iDate = col('acq_date'), iTime = col('acq_time'),
    iSat = col('satellite');
  if (iLat < 0 || iLon < 0) return [];
  const all: Fire[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.split(',');
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = (f[iTime] ?? '').padStart(4, '0');
    all.push({
      lat,
      lon,
      frp: Number(f[iFrp]) || 0,
      confidence: f[iConf] ?? 'n',
      acquired: `${f[iDate] ?? ''} ${t.slice(0, 2)}:${t.slice(2)}`,
      sensor: f[iSat] ?? 'VIIRS',
    });
  }
  // keep the most significant fires when over budget (biggest FRP, not a
  // geographic head-of-CSV slice)
  if (all.length > MAX_FIRES) {
    all.sort((a, b) => b.frp - a.frp);
    all.length = MAX_FIRES;
  }
  return all;
}

const vertexShader = /* glsl */ `
  attribute float aHeat;   // 0..1 normalized FRP
  attribute float aSeed;
  varying vec2 vUv;
  varying float vHeat;
  varying float vSeed;
  void main() {
    vUv = uv;
    vHeat = aHeat;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vHeat;
  varying float vSeed;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float flicker = 0.82 + 0.18 * sin(uTime * (2.0 + vSeed * 3.0) + vSeed * 40.0);
    float a = smoothstep(1.0, 0.1, r) * flicker * (0.55 + 0.45 * vHeat);
    if (a < 0.03) discard;
    // ember ramp: yellow → orange → red with heat
    vec3 col = mix(vec3(1.0, 0.85, 0.3), vec3(1.0, 0.25, 0.08), vHeat);
    gl_FragColor = vec4(col, a);
  }
`;

export const wildfiresLayer: LayerDef = {
  id: 'fires',
  label: 'WILDFIRES',
  defaultOn: true,
  attribution: 'NASA FIRMS',
  init(ctx: LayerCtx): LayerInstance {
    const geometry = new THREE.CircleGeometry(1, 12);
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_FIRES);
    mesh.frustumCulled = false;
    mesh.count = 0;
    const heatAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIRES), 1);
    const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIRES), 1);
    geometry.setAttribute('aHeat', heatAttr);
    geometry.setAttribute('aSeed', seedAttr);
    ctx.scene.add(mesh);

    let fires: Fire[] = [];
    const positions = new Float32Array(MAX_FIRES * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    const scl = new THREE.Vector3();

    function rebuild(): void {
      mesh.count = fires.length;
      fires.forEach((f, i) => {
        latLngToWorld(f.lat, f.lon, 0.004, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        q.setFromUnitVectors(up, pos.clone().normalize());
        // FRP spans ~0.5 → 1000+ MW; log-scale into marker size + heat
        const heat = Math.min(Math.log10(Math.max(f.frp, 1)) / 3, 1);
        const s = 0.22 + heat * 0.9;
        scl.set(s, s, s);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        heatAttr.setX(i, heat);
        seedAttr.setX(i, (i % 97) / 97);
      });
      mesh.instanceMatrix.needsUpdate = true;
      heatAttr.needsUpdate = true;
      seedAttr.needsUpdate = true;
    }

    async function fetchCsv(): Promise<string> {
      // 1st choice: client-direct (key baked at build; private repo)
      if (__FIRMS_KEY__) {
        try {
          const res = await fetch(
            `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${__FIRMS_KEY__}/${FIRMS_SOURCE}/world/1`,
          );
          if (res.ok) return await res.text();
          console.warn(`[fires] FIRMS direct HTTP ${res.status} — falling back to proxy`);
        } catch {
          console.warn('[fires] FIRMS direct fetch blocked — falling back to proxy');
        }
      }
      // fallback: server proxy (uses FIRMS_MAP_KEY from server env)
      const res = await fetch('/api/proxy/fires', {
        headers: { Authorization: `Bearer ${__ORRERY_TOKEN__}` },
      });
      if (!res.ok) throw new Error(`fires proxy HTTP ${res.status}`);
      return await res.text();
    }

    async function refresh(): Promise<void> {
      try {
        fires = parseCsv(await fetchCsv());
        rebuild();
      } catch (err) {
        console.warn('[fires] refresh failed (is FIRMS_MAP_KEY set?)', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < fires.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < 100 * 100) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const f = fires[best.i]!;
      const conf = f.confidence === 'h' ? 'high' : f.confidence === 'l' ? 'low' : 'nominal';
      const size =
        f.frp < 5 ? 'Small heat detection'
        : f.frp < 50 ? 'Moderate fire activity'
        : f.frp < 300 ? 'Large fire activity'
        : 'Very intense fire activity';
      const sat = SAT_NAMES[f.sensor] ?? f.sensor;
      const detectedMs = Date.parse(`${f.acquired.replace(' ', 'T')}:00Z`);
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: `FIRE · ${f.frp.toFixed(0)} MW`,
            subtitle: 'satellite detection',
            note: `${size} — one ~375 m satellite pixel radiating ${f.frp.toFixed(0)} MW of heat.`,
            rows: [
              { label: 'INTENSITY', value: `${f.frp.toFixed(1)} MW (fire radiative power)` },
              { label: 'CONFIDENCE', value: conf },
              {
                label: 'DETECTED',
                value: Number.isFinite(detectedMs)
                  ? `${agoShort(detectedMs)} · ${utcShort(detectedMs)}`
                  : `${f.acquired}Z`,
              },
              { label: 'SATELLITE', value: sat },
              { label: 'POSITION', value: latLon(f.lat, f.lon) },
            ],
          }),
      };
    });

    return {
      update(nowMs) {
        material.uniforms.uTime!.value = (nowMs / 1000) % 1000;
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
