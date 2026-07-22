/**
 * Corner readout: UTC clock, computed subsolar point (the terminator's
 * ground truth), FPS, and the aircraft feed line (count · data age · link).
 */
import { useEffect, useState } from 'react';
import { subsolarPoint } from '../globe/solar';
import { DEBUG_UI } from '../prefs';
import { apiGet } from '../feed/api';
import type { AircraftStore } from '../feed/aircraftStore';
import type { FeedStatus } from '../feed/useAircraftFeed';

const style: React.CSSProperties = {
  position: 'fixed',
  top: 10,
  left: 12,
  font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'rgba(143, 163, 184, 0.85)',
  userSelect: 'none',
  pointerEvents: 'none',
  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
};

function fmt(deg: number, pos: string, neg: string): string {
  return `${Math.abs(deg).toFixed(1)}°${deg >= 0 ? pos : neg}`;
}

interface UpstreamHealth {
  state: 'ok' | 'degraded' | 'down';
  reason: string | null;
}

export function Hud({ store, feedStatus }: { store: AircraftStore; feedStatus: FeedStatus }) {
  const [now, setNow] = useState(() => new Date());
  const [fps, setFps] = useState<number | null>(null);
  const [health, setHealth] = useState<UpstreamHealth | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<UpstreamHealth>('/api/health/upstreams')
        .then((h) => alive && setHealth(h))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // FPS is builder telemetry, not viewer information — a backgrounded tab
  // legitimately reads 0 and looks broken. ?debug=1 only.
  useEffect(() => {
    if (!DEBUG_UI) return;
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        setFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const sun = subsolarPoint(now);
  const clock = now.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
  const stats = store.stats();
  const dataAgeS = stats.fetchedAt ? Math.max(0, Math.round(now.getTime() / 1000 - stats.fetchedAt)) : null;
  // The websocket being LIVE says nothing about whether the data behind it is
  // fresh: during the 2026-07-22 OpenSky outage the socket stayed up while the
  // picture silently aged. The server's derived verdict is the honest one.
  const linkLabel =
    feedStatus === 'live' ? 'LIVE' : feedStatus === 'connecting' ? 'CONNECTING…' : 'RECONNECTING…';
  const link = health && health.state !== 'ok' && feedStatus === 'live'
    ? health.state === 'down' ? 'FEED DOWN' : 'FEED DEGRADED'
    : linkLabel;
  const linkColor =
    health?.state === 'down' ? '#ff5a5a'
      : health?.state === 'degraded' ? '#ffb300'
        : feedStatus === 'live' ? 'rgba(143,163,184,0.85)' : '#ffb300';

  return (
    <div style={style}>
      ORRERY · {clock}
      <br />
      SUN {fmt(sun.lat, 'N', 'S')} {fmt(sun.lng, 'E', 'W')}
      {fps !== null && <> · {fps} FPS</>}
      <br />
      <span style={{ color: linkColor }} title={health?.reason ?? undefined}>
        {link}
        {stats.rendered > 0 && <> · {stats.rendered.toLocaleString()} AIRCRAFT</>}
        {dataAgeS !== null && <> · DATA {dataAgeS}s</>}
        {health?.reason && health.state !== 'ok' && <> · {health.reason}</>}
      </span>
    </div>
  );
}
