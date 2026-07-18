/**
 * World events — GDACS (Global Disaster Alert & Coordination System),
 * client-direct (CORS-open, keyless; verified 2026-07-18).
 *
 * Deliberately scoped to classes ORRERY doesn't already render (adversarial
 * review: GDACS overlaps ~60% with existing layers): floods, volcanoes,
 * droughts always; tropical cyclones only OUTSIDE NHC's basins (GDACS is
 * global — this patches the documented WPac/JTWC gap in cyclones.ts);
 * earthquakes and wildfires are skipped entirely (USGS/FIRMS own those).
 *
 * Marks are alert-level-colored diamonds (GDACS Green/Orange/Red); Red pulses.
 */
import * as THREE from 'three';
import type { LayerCtx, LayerDef, LayerInstance } from './registry';
import { latLngToWorld } from '../globe/surfaceMath';
import { agoShort, utcShort, latLon } from '../format';

const FEED_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP';
const REFRESH_MS = 30 * 60_000;
const MAX_EVENTS = 256;
const PICK_RADIUS_PX = 16;
const PULSE_PERIOD_S = 2.5;

/** NHC's cyclones layer covers Atl/EPac/CPac: lon -180..0 & Atlantic. GDACS
 * TCs west of the dateline (or Indian Ocean) fill the coverage gap. */
function inNhcBasins(lat: number, lon: number): boolean {
  return lon >= -180 && lon <= -20 && lat >= 0;
}

interface GdacsEvent {
  id: string;
  type: 'FL' | 'VO' | 'DR' | 'TC';
  name: string;
  country: string;
  alert: 'Green' | 'Orange' | 'Red';
  score: number;
  fromMs: number;
  lat: number;
  lon: number;
  url: string;
}

const TYPE_INFO: Record<GdacsEvent['type'], { word: string; note: string }> = {
  FL: { word: 'Flood', note: 'Active flooding reported in this area.' },
  VO: { word: 'Volcanic activity', note: 'Volcano showing elevated activity or eruption.' },
  DR: { word: 'Drought', note: 'Prolonged drought conditions affecting this region.' },
  TC: { word: 'Tropical cyclone', note: 'Active storm outside NHC coverage (West Pacific / Indian Ocean).' },
};

const ALERT_COLORS: Record<GdacsEvent['alert'], THREE.Color> = {
  Green: new THREE.Color(0x5fb8a8), // muted teal — awareness, not alarm
  Orange: new THREE.Color(0xffb14d),
  Red: new THREE.Color(0xff5a5a),
};

const ALERT_NOTE: Record<GdacsEvent['alert'], string> = {
  Green: 'low humanitarian impact expected',
  Orange: 'moderate humanitarian impact possible',
  Red: 'high humanitarian impact expected',
};

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aRed; // 1 = Red alert → pulses
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vRed;
  void main() {
    vUv = uv;
    vColor = aColor;
    vRed = aRed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uPhase;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vRed;
  void main() {
    // diamond: distance in rotated (manhattan) space
    vec2 p = abs(vUv - 0.5) * 2.0;
    float d = p.x + p.y;                      // 0 center → 1 at diamond edge
    float core = smoothstep(0.55, 0.35, d);
    float rim = smoothstep(0.08, 0.0, abs(d - 0.75)) * 0.7;
    float pulse = vRed * smoothstep(0.12, 0.0, abs(d - uPhase * 1.2)) * (1.0 - uPhase) * 0.9;
    float a = max(max(core * 0.9, rim), pulse);
    if (a < 0.03) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export const worldEventsLayer: LayerDef = {
  id: 'events',
  label: 'WORLD EVENTS',
  defaultOn: true,
  attribution: 'GDACS',
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
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_EVENTS);
    mesh.frustumCulled = false;
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EVENTS * 3), 3);
    const redAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EVENTS), 1);
    geometry.setAttribute('aColor', colorAttr);
    geometry.setAttribute('aRed', redAttr);
    ctx.scene.add(mesh);

    let events: GdacsEvent[] = [];
    const positions = new Float32Array(MAX_EVENTS * 3);
    const pos = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    const scale = new THREE.Vector3();

    function rebuild(): void {
      mesh.count = events.length;
      events.forEach((ev, i) => {
        latLngToWorld(ev.lat, ev.lon, 0.007, pos);
        positions[i * 3] = pos.x;
        positions[i * 3 + 1] = pos.y;
        positions[i * 3 + 2] = pos.z;
        const normal = pos.clone().normalize();
        q.setFromUnitVectors(up, normal);
        const s = ev.alert === 'Red' ? 2.6 : ev.alert === 'Orange' ? 1.9 : 1.3;
        scale.set(s, s, s);
        m.compose(pos, q, scale);
        mesh.setMatrixAt(i, m);
        const c = ALERT_COLORS[ev.alert];
        colorAttr.array[i * 3] = c.r;
        colorAttr.array[i * 3 + 1] = c.g;
        colorAttr.array[i * 3 + 2] = c.b;
        redAttr.array[i] = ev.alert === 'Red' ? 1 : 0;
      });
      mesh.instanceMatrix.needsUpdate = true;
      colorAttr.needsUpdate = true;
      redAttr.needsUpdate = true;
    }

    async function refresh(): Promise<void> {
      try {
        const res = await fetch(FEED_URL);
        if (!res.ok) throw new Error(`GDACS HTTP ${res.status}`);
        const data = (await res.json()) as {
          features: Array<{
            properties: {
              eventtype: string;
              eventid: number;
              name?: string;
              eventname?: string;
              country?: string;
              alertlevel?: string;
              alertscore?: number;
              fromdate?: string;
              iscurrent?: string | boolean;
              url?: { report?: string; details?: string } | string;
            };
            geometry: { coordinates: [number, number] };
          }>;
        };
        events = data.features
          .filter((f) => {
            const p = f.properties;
            const current = p.iscurrent === true || p.iscurrent === 'true';
            if (!current) return false;
            const [lon, lat] = f.geometry.coordinates;
            if (p.eventtype === 'FL' || p.eventtype === 'VO' || p.eventtype === 'DR') return true;
            // TCs only where NHC (cyclones layer) has no coverage
            if (p.eventtype === 'TC') return !inNhcBasins(lat, lon);
            return false; // EQ → USGS layer, WF → FIRMS layer
          })
          .slice(0, MAX_EVENTS)
          .map((f) => {
            const p = f.properties;
            const rawUrl = p.url;
            const link =
              typeof rawUrl === 'string' ? rawUrl : rawUrl?.report ?? rawUrl?.details ?? 'https://www.gdacs.org';
            const alert = (p.alertlevel === 'Red' || p.alertlevel === 'Orange' ? p.alertlevel : 'Green') as GdacsEvent['alert'];
            return {
              id: `${p.eventtype}-${p.eventid}`,
              type: p.eventtype as GdacsEvent['type'],
              name: p.eventname || p.name || TYPE_INFO[p.eventtype as GdacsEvent['type']].word,
              country: p.country || '—',
              alert,
              score: p.alertscore ?? 0,
              fromMs: p.fromdate ? Date.parse(p.fromdate) : Date.now(),
              lat: f.geometry.coordinates[1],
              lon: f.geometry.coordinates[0],
              url: link,
            };
          });
        rebuild();
      } catch (err) {
        console.warn('[events] GDACS refresh failed', err);
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    const proj = new THREE.Vector3();
    const unregister = ctx.registerPicker((px, py, rect, camera) => {
      const r2 = 100 * 100;
      let best: { d2: number; i: number } | null = null;
      for (let i = 0; i < events.length; i++) {
        proj.fromArray(positions, i * 3);
        if (proj.dot(camera.position) < r2) continue;
        proj.project(camera);
        const sx = ((proj.x + 1) / 2) * rect.width;
        const sy = ((1 - proj.y) / 2) * rect.height;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < PICK_RADIUS_PX ** 2 && (!best || d2 < best.d2)) best = { d2, i };
      }
      if (!best) return null;
      const ev = events[best.i]!;
      const info = TYPE_INFO[ev.type];
      return {
        d2: best.d2,
        open: () =>
          ctx.setCard({
            title: ev.name,
            subtitle: info.word.toLowerCase(),
            note: `${info.note} GDACS ${ev.alert} alert — ${ALERT_NOTE[ev.alert]}.`,
            rows: [
              { label: 'COUNTRY', value: ev.country },
              { label: 'ALERT', value: `${ev.alert} (score ${ev.score.toFixed(1)})` },
              { label: 'SINCE', value: `${agoShort(ev.fromMs)} · ${utcShort(ev.fromMs)}` },
              { label: 'POSITION', value: latLon(ev.lat, ev.lon) },
            ],
            href: ev.url,
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
