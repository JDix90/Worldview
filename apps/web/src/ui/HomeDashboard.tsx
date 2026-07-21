/**
 * HOME dashboard — everything relevant around the set home location, in one
 * panel: weather, overhead traffic, nearby signals (full analyst narratives),
 * GPS-watch exceptions, and the morning briefing. Data = the same Stage-4
 * digest the appliance panel renders (/api/pager/summary) + client-direct
 * Open-Meteo current weather (keyless, CORS-open — verified live).
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../feed/api';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const chipStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 134,
  right: 12,
  cursor: 'pointer',
  font: `11px ${mono}`,
  color: 'rgba(143,163,184,0.85)',
  padding: '4px 10px',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 3,
  background: 'rgba(6,10,16,0.7)',
  userSelect: 'none',
};

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 14,
  right: 12,
  width: 330,
  maxHeight: '78vh',
  overflowY: 'auto',
  padding: '10px 12px',
  font: `11px/1.6 ${mono}`,
  color: 'rgba(200,214,229,0.92)',
  background: 'rgba(6,10,16,0.92)',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
  userSelect: 'none',
};

const CYAN = '#4fd8ff';
const DIM = 'rgba(143,163,184,0.85)';
const AMBER = '#ffb300';
const RED = '#ff5a5a';
const GREEN = '#6be36b';

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'thunderstorm w/ hail',
};

function compassFromDeg(deg: number): string {
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(deg / 22.5) % 16]!;
}

interface Summary {
  home?: { lat: number; lon: number };
  feed?: { live: boolean; aircraft: number; dataAgeS: number };
  signals?: Array<{
    severity: string; what: string; region: string | null; disposition: string | null;
    narrative: string | null; ageS: number; place: string | null; distMi: number | null;
    bearing: string | null; route: string | null;
    aircraft: { callsign: string | null; altFt: number | null; live: boolean; stillSquawking: boolean } | null;
  }>;
  briefing?: { date: string; quiet: boolean; headline: string; open: string } | null;
  integrity?: Array<{ name: string; verdict: string; pct: number | null }>;
  overhead?: { count: number; milCount: number; tops: Array<{ callsign: string | null; altFt: number | null; distMi: number; bearing: string; mil: boolean; typeDesc: string | null }> };
  shadowS1Last24h?: number;
}

interface Weather {
  tempF: number;
  feelsF: number;
  word: string;
  windMph: number;
  windDir: string;
}

function statusOf(s: Summary): 'red' | 'amber' | 'green' {
  if (!s.feed?.live || (s.shadowS1Last24h ?? 0) > 0) return 'red';
  if (s.integrity?.some((r) => r.verdict === 'severe')) return 'red';
  if (s.signals?.some((x) => x.severity === 'S1')) return 'red';
  if (s.integrity?.some((r) => r.verdict === 'elevated') || (s.signals?.length ?? 0) > 0) return 'amber';
  return 'green';
}

function ago(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.floor(sec / 60)}m`;
  if (sec < 172800) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const Section = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <div style={{ marginTop: 10 }}>
    <div style={{ display: 'flex' }}>
      <span style={{ color: CYAN, letterSpacing: 1 }}>{title}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
    {children}
  </div>
);

export function HomeDashboard() {
  const [open, setOpen] = useState(false);
  const [sum, setSum] = useState<Summary | null>(null);
  const [label, setLabel] = useState<string>('');
  const [wx, setWx] = useState<Weather | null>(null);
  const sumTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const wxTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      clearInterval(sumTimer.current);
      clearInterval(wxTimer.current);
      return;
    }
    const loadSum = () => {
      void apiGet<Summary>('/api/pager/summary').then(setSum).catch(() => {});
      void apiGet<{ label?: string }>('/api/settings/home').then((h) => setLabel(h.label ?? '')).catch(() => {});
    };
    loadSum();
    sumTimer.current = setInterval(loadSum, 90_000);
    return () => {
      clearInterval(sumTimer.current);
      clearInterval(wxTimer.current);
    };
  }, [open]);

  // weather depends on home coords — refetch when they arrive/change
  const homeKey = sum?.home ? `${sum.home.lat},${sum.home.lon}` : '';
  useEffect(() => {
    if (!open || !sum?.home) return;
    const { lat, lon } = sum.home;
    const load = () => {
      void fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { current?: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number; wind_direction_10m: number } } | null) => {
          const c = d?.current;
          if (!c) return;
          setWx({
            tempF: Math.round(c.temperature_2m),
            feelsF: Math.round(c.apparent_temperature),
            word: WMO[c.weather_code] ?? `wx ${c.weather_code}`,
            windMph: Math.round(c.wind_speed_10m),
            windDir: compassFromDeg(c.wind_direction_10m),
          });
        })
        .catch(() => {});
    };
    load();
    clearInterval(wxTimer.current);
    wxTimer.current = setInterval(load, 10 * 60_000);
  }, [open, homeKey]);

  const flyHome = () => {
    const g = (window as { __ORRERY__?: { globe?: { pointOfView(p: object, ms: number): void } } }).__ORRERY__?.globe;
    if (g && sum?.home) g.pointOfView({ lat: sum.home.lat, lng: sum.home.lon, altitude: 1.0 }, 900);
  };

  if (!open) {
    return (
      <div style={chipStyle} onClick={() => setOpen(true)} title="What's happening around your home location">
        HOME <span style={{ color: CYAN }}>▣</span>
      </div>
    );
  }

  const st = sum ? statusOf(sum) : 'green';
  const dot = { red: RED, amber: AMBER, green: GREEN }[st];
  const near = (sum?.signals ?? []).filter((x) => x.distMi != null && x.distMi < 500);
  const far = (sum?.signals ?? []).length - near.length;
  const exceptions = (sum?.integrity ?? []).filter((r) => r.verdict === 'elevated' || r.verdict === 'severe');

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, alignSelf: 'center' }} />
        <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>HOME</span>
        <span style={{ opacity: 0.55 }}>{label || '—'}</span>
        <span style={{ flex: 1 }} />
        <span onClick={flyHome} style={{ cursor: 'pointer', color: CYAN, opacity: 0.85 }} title="Point the globe at home">
          ⤓ fly
        </span>
        <span onClick={() => setOpen(false)} style={{ cursor: 'pointer', opacity: 0.6, marginLeft: 8 }}>✕</span>
      </div>

      {sum?.feed && (
        <div style={{ opacity: 0.7, marginTop: 2 }}>
          feed {sum.feed.live ? 'LIVE' : 'DOWN'} · {sum.feed.aircraft.toLocaleString()} aircraft ·{' '}
          {sum.shadowS1Last24h ?? 0} S1/24h
        </div>
      )}

      <Section title="WEATHER">
        {wx ? (
          <div>
            {wx.tempF}°F <span style={{ opacity: 0.55 }}>(feels {wx.feelsF}°)</span> · {wx.word} · wind {wx.windMph} mph {wx.windDir}
          </div>
        ) : (
          <div style={{ opacity: 0.5 }}>loading…</div>
        )}
      </Section>

      <Section
        title="OVERHEAD"
        right={
          sum?.overhead?.milCount ? <span style={{ color: AMBER }}>{sum.overhead.milCount} MIL</span> : undefined
        }
      >
        {sum?.overhead ? (
          <>
            <div>{sum.overhead.count} aircraft within 150 mi</div>
            {sum.overhead.tops.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, opacity: 0.9 }}>
                <span style={{ color: t.mil ? AMBER : 'inherit', minWidth: 70 }}>{t.callsign?.trim() || '—'}</span>
                <span style={{ opacity: 0.6 }}>
                  {t.altFt ? `${t.altFt.toLocaleString()} ft · ` : ''}{t.distMi}mi {t.bearing}
                  {t.typeDesc ? ` · ${t.typeDesc}` : ''}
                </span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ opacity: 0.5 }}>loading…</div>
        )}
      </Section>

      <Section title="NEARBY SIGNALS">
        {near.length === 0 ? (
          <div style={{ opacity: 0.6 }}>
            nothing near you{far > 0 ? ` · ${far} signal${far === 1 ? '' : 's'} elsewhere — see FEED` : ''}
          </div>
        ) : (
          near.map((x, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: x.severity === 'S1' ? RED : AMBER }}>{x.severity}</span>
                <span>{x.aircraft?.callsign?.trim() || x.place || x.region || '—'}</span>
                {x.route && <span style={{ opacity: 0.7 }}>{x.route}</span>}
                <span style={{ flex: 1 }} />
                {x.aircraft && (
                  <span style={{ color: x.aircraft.stillSquawking ? AMBER : DIM, fontSize: 10 }}>
                    {x.aircraft.stillSquawking ? 'ACTIVE' : 'CLEARED'}
                  </span>
                )}
              </div>
              <div style={{ opacity: 0.6 }}>
                {x.distMi}mi {x.bearing} of you · {ago(x.ageS)} ago
                {x.aircraft?.altFt ? ` · ${x.aircraft.altFt.toLocaleString()} ft` : ''}
              </div>
              {(x.narrative || x.disposition) && (
                <div style={{ color: CYAN, opacity: 0.85 }}>› {x.narrative || x.disposition}</div>
              )}
            </div>
          ))
        )}
      </Section>

      <Section title="GPS WATCH">
        {exceptions.length === 0 ? (
          <div style={{ color: GREEN, opacity: 0.85 }}>all regions nominal</div>
        ) : (
          exceptions.map((r, i) => (
            <div key={i}>
              {r.name}:{' '}
              <span style={{ color: r.verdict === 'severe' ? RED : AMBER }}>
                {r.verdict.toUpperCase()}{r.pct != null ? ` ${r.pct}%` : ''}
              </span>
            </div>
          ))
        )}
      </Section>

      {sum?.briefing && (
        <Section
          title="BRIEFING"
          right={
            <span style={{ color: sum.briefing.quiet ? DIM : AMBER, fontSize: 10 }}>
              {sum.briefing.quiet ? 'QUIET' : 'ACTIVE'}
            </span>
          }
        >
          <div style={{ opacity: 0.9 }}>{sum.briefing.headline.replace(/\*\*/g, '')}</div>
          <div
            style={{
              opacity: 0.6,
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {sum.briefing.open.replace(/\*\*/g, '')}
          </div>
        </Section>
      )}
    </div>
  );
}
