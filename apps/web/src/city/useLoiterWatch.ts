/**
 * Loiter watch (round 1 L4, #125): samples the live aircraft stores every
 * 20 s for traffic near home, keeps ~23-minute ring buffers per airframe,
 * and pushes flagged loiterers into the CITY map's data. Runs whenever the
 * app is open — the buffer must exist BEFORE you open the map, or "why is
 * that helicopter circling?" could never be answered on arrival.
 *
 * Furniture, not pipeline: no signals, no severities (loiterHeuristic.ts
 * header has the discipline note).
 */
import { useEffect, useRef } from 'react';
import type { AircraftStore } from '../feed/aircraftStore';
import { assessTrack, LOITER_WINDOW_MS, type LoiterVerdict, type TrackSample } from './loiterHeuristic';

export interface LoiterFlag {
  hex: string;
  callsign: string;
  mil: boolean;
  altFt: number | null;
  lat: number;
  lon: number;
  verdict: LoiterVerdict;
  trail: TrackSample[];
}

export interface LoiterData {
  watchingSinceMs: number;
  flags: LoiterFlag[];
}

const SAMPLE_MS = 20_000;
const NEAR_MI = 15;
const BUFFER_MS = LOITER_WINDOW_MS + 3 * 60_000;

const DEG = Math.PI / 180;
function distMi(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const h =
    Math.sin(((bLat - aLat) * DEG) / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(((bLon - aLon) * DEG) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function useLoiterWatch(
  store: AircraftStore,
  milStore: AircraftStore,
  home: { lat: number; lon: number } | null,
  setLayerData: (id: string, d: unknown) => void,
): void {
  const buffers = useRef(new Map<string, { samples: TrackSample[]; callsign: string; mil: boolean; altFt: number | null }>());
  const since = useRef(Date.now());

  useEffect(() => {
    if (!home) return;
    since.current = Date.now();
    buffers.current.clear();

    const tick = () => {
      const now = Date.now();
      const scan = (s: AircraftStore, mil: boolean) => {
        for (const [hex, t] of s.byHex) {
          const st = t.state;
          if (st.onGround) continue;
          const lat = t.renderLat, lon = t.renderLon;
          if (distMi(home.lat, home.lon, lat, lon) > NEAR_MI) continue;
          let buf = buffers.current.get(hex);
          if (!buf) {
            buf = { samples: [], callsign: st.callsign?.trim() || hex, mil, altFt: null };
            buffers.current.set(hex, buf);
          }
          buf.callsign = st.callsign?.trim() || buf.callsign;
          buf.altFt = st.altBaroM != null ? Math.round(st.altBaroM * 3.28084) : buf.altFt;
          buf.samples.push({ t: now, lat, lon, altFt: buf.altFt });
        }
      };
      scan(store, false);
      scan(milStore, true);

      // prune: old samples within buffers, and buffers with nothing recent
      for (const [hex, buf] of buffers.current) {
        buf.samples = buf.samples.filter((s) => now - s.t <= BUFFER_MS);
        if (buf.samples.length === 0 || now - buf.samples[buf.samples.length - 1]!.t > 5 * 60_000) {
          buffers.current.delete(hex);
        }
      }

      const flags: LoiterFlag[] = [];
      for (const [hex, buf] of buffers.current) {
        const v = assessTrack(buf.samples, now);
        if (v?.loitering) {
          const last = buf.samples[buf.samples.length - 1]!;
          flags.push({
            hex,
            callsign: buf.callsign,
            mil: buf.mil,
            altFt: buf.altFt,
            lat: last.lat,
            lon: last.lon,
            verdict: v,
            trail: buf.samples,
          });
        }
      }
      setLayerData('loiter', { watchingSinceMs: since.current, flags } satisfies LoiterData);
    };

    tick();
    const id = window.setInterval(tick, SAMPLE_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home?.lat, home?.lon, store, milStore]);
}
