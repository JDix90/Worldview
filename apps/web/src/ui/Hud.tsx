/**
 * Corner readout: UTC clock, computed subsolar point (the terminator's
 * ground truth), FPS, and the aircraft feed line (count · data age · link).
 */
import { useEffect, useState } from 'react';
import { subsolarPoint } from '../globe/solar';
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

export function Hud({ store, feedStatus }: { store: AircraftStore; feedStatus: FeedStatus }) {
  const [now, setNow] = useState(() => new Date());
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
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
  const link =
    feedStatus === 'live' ? 'LIVE' : feedStatus === 'connecting' ? 'CONNECTING…' : 'RECONNECTING…';
  const linkColor = feedStatus === 'live' ? 'rgba(143,163,184,0.85)' : '#ffb300';

  return (
    <div style={style}>
      ORRERY · {clock}
      <br />
      SUN {fmt(sun.lat, 'N', 'S')} {fmt(sun.lng, 'E', 'W')}
      {fps !== null && <> · {fps} FPS</>}
      <br />
      <span style={{ color: linkColor }}>
        {link}
        {stats.rendered > 0 && <> · {stats.rendered.toLocaleString()} AIRCRAFT</>}
        {dataAgeS !== null && <> · DATA {dataAgeS}s</>}
      </span>
    </div>
  );
}
