/**
 * HOME dashboard — everything relevant around the set home location, in one
 * panel: weather, overhead traffic, nearby signals (full analyst narratives),
 * GPS-watch exceptions, and the morning briefing. Data = the same Stage-4
 * digest the appliance panel renders (/api/pager/summary) + client-direct
 * Open-Meteo current weather (keyless, CORS-open — verified live).
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../feed/api';
import { fetchRoute } from '../feed/routes';
import { fetchSpaceWeather, auroraVerdict, type SpaceWeather } from '../sky/spaceWeather';
import { nextIssPasses, type Pass } from '../sky/passes';
import { sublunarPoint } from '../globe/lunar';
import { Chip } from './Chip';
import { OverheadRadar, MoonDisc, AqiBar } from './dashViz';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

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

const DEG = Math.PI / 180;
function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bearingCompass(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return compassFromDeg(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** US AQI band → [word, color]. */
function aqiBand(aqi: number): [string, string] {
  if (aqi <= 50) return ['good', GREEN];
  if (aqi <= 100) return ['moderate', AMBER];
  if (aqi <= 150) return ['unhealthy for sensitive', '#ff9d4d'];
  if (aqi <= 200) return ['unhealthy', RED];
  return ['very unhealthy', '#c86bff'];
}

interface Conditions {
  aqi: { us: number; pm25: number } | null;
  alerts: Array<{ event: string; severity: string; until: string }>;
  fires: { count: number; nearestMi: number; nearestDir: string } | 'none' | 'unavailable' | null;
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
  briefing?: { date: string; quiet: boolean; lead: string; changed: string | null; signoff: string | null } | null;
  integrity?: Array<{ name: string; verdict: string; pct: number | null }>;
  overhead?: { count: number; milCount: number; tops: Array<{ callsign: string | null; altFt: number | null; distMi: number; bearing: string; dxMi?: number; dyMi?: number; mil: boolean; typeDesc: string | null }> };
  shadowS1Last24h?: number;
  airport?: { code: string; type: string; reason: string; detail: string } | null;
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

interface HomeDashboardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chip hides while another right-dock panel is open (one surface at a time). */
  chipVisible: boolean;
  bottom: number;
}

export function HomeDashboard({ open, onOpenChange, chipVisible, bottom }: HomeDashboardProps) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [label, setLabel] = useState<string>('');
  const [wx, setWx] = useState<Weather | null>(null);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [cond, setCond] = useState<Conditions>({ aqi: null, alerts: [], fires: null });
  // home-coords key — effects below refetch when it changes
  const homeKey = sum?.home ? `${sum.home.lat},${sum.home.lon}` : '';
  const [sw, setSw] = useState<SpaceWeather | null>(null);
  const swTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const load = () => void fetchSpaceWeather().then(setSw).catch(() => {});
    load();
    swTimer.current = setInterval(load, 15 * 60_000);
    return () => clearInterval(swTimer.current);
  }, [open]);

  const [passes, setPasses] = useState<Pass[] | null>(null);
  useEffect(() => {
    if (!open || !sum?.home) return;
    let alive = true;
    nextIssPasses(sum.home.lat, sum.home.lon, 24)
      .then((p) => alive && setPasses(p))
      .catch(() => alive && setPasses([]));
    return () => {
      alive = false;
    };
  }, [open, homeKey]); // eslint-disable-line react-hooks/exhaustive-deps
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

  // origin→destination for the overhead tops (adsbdb, cache-hot via routes.ts)
  const topKey = (sum?.overhead?.tops ?? []).map((t) => t.callsign ?? '').join(',');
  useEffect(() => {
    if (!open) return;
    for (const t of sum?.overhead?.tops ?? []) {
      const cs = t.callsign?.trim();
      if (!cs || routes[cs] !== undefined) continue;
      void fetchRoute(cs).then((r) => {
        setRoutes((prev) => ({ ...prev, [cs]: r ? `${r.origin.city} → ${r.destination.city}` : '' }));
      });
    }
  }, [open, topKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // local conditions: AQI + NWS alerts + FIRMS fires near home
  const condTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!open || !sum?.home) return;
    const { lat, lon } = sum.home;
    const load = async () => {
      const next: Conditions = { aqi: null, alerts: [], fires: null };
      // air quality
      try {
        const d = (await (
          await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5`)
        ).json()) as { current?: { us_aqi: number; pm2_5: number } };
        if (d.current) next.aqi = { us: Math.round(d.current.us_aqi), pm25: Math.round(d.current.pm2_5 * 10) / 10 };
      } catch { /* absent */ }
      // NWS active alerts (US only — 404s gracefully abroad)
      try {
        const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
        if (r.ok) {
          const d = (await r.json()) as { features?: Array<{ properties?: { event?: string; severity?: string; ends?: string; expires?: string } }> };
          next.alerts = (d.features ?? []).slice(0, 2).map((f) => {
            const p = f.properties ?? {};
            const end = p.ends || p.expires || '';
            return { event: p.event ?? 'Alert', severity: p.severity ?? '', until: end ? end.slice(11, 16) : '' };
          });
        }
      } catch { /* absent */ }
      // FIRMS fire detections within ~150 mi, via the same-origin proxy:
      // FIRMS omits CORS headers on error responses, so a direct browser
      // fetch throws on any rate-limit/error; the proxy (cached, stale-serve)
      // is reliable. (DECISIONS #100)
      try {
        const bbox = `${(lon - 2.8).toFixed(2)},${(lat - 2.2).toFixed(2)},${(lon + 2.8).toFixed(2)},${(lat + 2.2).toFixed(2)}`;
        const res = await fetch(`/api/proxy/fires?bbox=${bbox}`, {
          headers: { Authorization: `Bearer ${__ORRERY_TOKEN__}` },
        });
        const text = await res.text();
        if (!res.ok || !text.toLowerCase().includes('latitude')) {
          next.fires = 'unavailable';
        } else {
          const lines = text.trim().split('\n');
          const header = lines[0]!.split(',');
          const li = header.indexOf('latitude');
          const oi = header.indexOf('longitude');
          let count = 0;
          let nearest = Infinity;
          let nearestDir = '';
          for (const ln of lines.slice(1)) {
            const c = ln.split(',');
            const flat = Number(c[li]);
            const flon = Number(c[oi]);
            if (!Number.isFinite(flat) || !Number.isFinite(flon)) continue;
            const d = haversineMi(lat, lon, flat, flon);
            if (d > 150) continue;
            count++;
            if (d < nearest) { nearest = d; nearestDir = bearingCompass(lat, lon, flat, flon); }
          }
          next.fires = count === 0 ? 'none' : { count, nearestMi: Math.round(nearest), nearestDir };
        }
      } catch {
        next.fires = 'unavailable';
      }
      setCond(next);
    };
    void load();
    clearInterval(condTimer.current);
    condTimer.current = setInterval(() => void load(), 10 * 60_000);
    return () => clearInterval(condTimer.current);
  }, [open, homeKey]);

  const flyHome = () => {
    const g = (window as { __ORRERY__?: { globe?: { pointOfView(p: object, ms: number): void } } }).__ORRERY__?.globe;
    if (g && sum?.home) g.pointOfView({ lat: sum.home.lat, lng: sum.home.lon, altitude: 1.0 }, 900);
  };

  const chipStatus = sum ? statusOf(sum) : 'green';

  if (!open) {
    if (!chipVisible) return null;
    // The status dot lets the chip report red/amber/green at a glance without
    // opening the dashboard.
    const dotColor = { red: RED, amber: AMBER, green: GREEN }[chipStatus];
    return (
      <Chip
        bottom={bottom}
        label="HOME"
        state={<span style={{ width: 8, height: 8, borderRadius: 4, background: dotColor, display: 'inline-block' }} />}
        title="What's happening around your home location"
        onClick={() => onOpenChange(true)}
      />
    );
  }

  const st = chipStatus;
  const dot = { red: RED, amber: AMBER, green: GREEN }[st];
  const near = (sum?.signals ?? []).filter((x) => x.distMi != null && x.distMi < 500);
  const far = (sum?.signals ?? []).length - near.length;

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
        <span onClick={() => onOpenChange(false)} style={{ cursor: 'pointer', opacity: 0.6, marginLeft: 8 }}>✕</span>
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
            {sum.overhead.tops.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 2px' }}>
                <OverheadRadar
                  blips={sum.overhead.tops.map((t) => ({
                    distMi: t.distMi,
                    bearing: t.bearing,
                    dxMi: t.dxMi,
                    dyMi: t.dyMi,
                    mil: t.mil,
                  }))}
                  homeLabel={label.replace(/^near\s+/i, '').split(',')[0] || undefined}
                />
              </div>
            )}
            <div>
              {sum.overhead.count} within 150 mi
              {sum.overhead.tops.length > 0 && (
                <span style={{ opacity: 0.5 }}>
                  {' '}· nearest {sum.overhead.tops.length} ≤{' '}
                  {Math.max(...sum.overhead.tops.map((t) => t.distMi))} mi
                </span>
              )}
            </div>
            {sum.overhead.tops.map((t, i) => {
              const cs = t.callsign?.trim();
              const route = cs ? routes[cs] : undefined;
              return (
                <div key={i} style={{ marginTop: 2 }}>
                  <div style={{ display: 'flex', gap: 8, opacity: 0.9 }}>
                    <span style={{ color: t.mil ? AMBER : 'inherit', minWidth: 70 }}>{cs || '—'}</span>
                    <span style={{ opacity: 0.6 }}>
                      {t.altFt ? `${t.altFt.toLocaleString()} ft · ` : ''}{t.distMi}mi {t.bearing}
                      {t.typeDesc ? ` · ${t.typeDesc}` : ''}
                    </span>
                  </div>
                  {route ? <div style={{ opacity: 0.5, paddingLeft: 78 }}>{route}</div> : null}
                </div>
              );
            })}
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

      <Section title="LOCAL CONDITIONS">
        {sum?.airport && (
          <div
            style={{
              color: sum.airport.type === 'ground-stop' || sum.airport.type === 'closure' ? RED : AMBER,
            }}
            title="FAA national airspace status for your home airport"
          >
            ✈ {sum.airport.code}: {sum.airport.type.replace('-', ' ')}
            {sum.airport.detail ? ` · ${sum.airport.detail}` : ''}
            {sum.airport.reason ? ` — ${sum.airport.reason.toLowerCase()}` : ''}
          </div>
        )}
        {/* air quality */}
        {cond.aqi ? (
          (() => {
            const [word, color] = aqiBand(cond.aqi.us);
            return (
              <div>
                AQI <span style={{ color }}>{cond.aqi.us} — {word}</span>
                <span style={{ opacity: 0.55 }}> · PM2.5 {cond.aqi.pm25} µg/m³</span>
                <AqiBar aqi={cond.aqi.us} />
              </div>
            );
          })()
        ) : (
          <div style={{ opacity: 0.5 }}>air quality loading…</div>
        )}
        {/* NWS alerts */}
        {cond.alerts.map((a, i) => {
          const sev = a.severity.toLowerCase();
          const col = sev === 'extreme' || sev === 'severe' ? RED : AMBER;
          return (
            <div key={i} style={{ color: col }}>
              ⚠ {a.event}{a.until ? <span style={{ opacity: 0.7 }}> · until {a.until}</span> : null}
            </div>
          );
        })}
        {/* FIRMS fire detections */}
        {cond.fires === null ? null : cond.fires === 'unavailable' ? (
          <div style={{ opacity: 0.45 }}>fire data unavailable</div>
        ) : cond.fires === 'none' ? (
          <div style={{ color: GREEN, opacity: 0.8 }}>no fire detections nearby (24 h)</div>
        ) : (
          <div style={{ color: '#ff9d4d' }}>
            🔥 {cond.fires.count} fire detection{cond.fires.count === 1 ? '' : 's'} within 150 mi
            <span style={{ opacity: 0.7 }}> · nearest {cond.fires.nearestMi}mi {cond.fires.nearestDir}</span>
          </div>
        )}
      </Section>

      <Section title="SKY TONIGHT">
        {passes === null ? (
          <div style={{ opacity: 0.5 }}>computing ISS passes…</div>
        ) : passes.length === 0 ? (
          <div style={{ opacity: 0.6 }}>no visible ISS pass in the next 24 h</div>
        ) : (
          (() => {
            const p = passes[0]!;
            const dt = new Date(p.riseMs);
            const today = new Date().getDate() === dt.getDate();
            const hm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            return (
              <div title="International Space Station — visible to the naked eye when sunlit against a dark sky">
                ISS {today ? 'tonight' : 'tomorrow'} {hm} · rises {p.riseDir} · max {p.maxElDeg}° ·{' '}
                {Math.round(p.durationS / 60)} min
                {p.bright && <span style={{ color: GREEN }}> · bright</span>}
              </div>
            );
          })()
        )}
        {(() => {
          const m = sublunarPoint(new Date());
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.85, marginTop: 2 }}>
              <MoonDisc illumination={m.illumination} waxing={m.waxing} />
              <span>
                moon: {m.phaseName.toLowerCase()} · {Math.round(m.illumination * 100)}% lit
              </span>
            </div>
          );
        })()}
      </Section>

      {sw && (
        <Section title="SPACE WEATHER">
          {sw.kpNow != null && (
            <div title="Planetary K-index: geomagnetic activity now, and the max forecast for the next 24h. ≥5 = storm.">
              Kp{' '}
              <span style={{ color: sw.kpNow >= 7 ? RED : sw.kpNow >= 5 ? AMBER : GREEN }}>
                {sw.kpNow.toFixed(1)}
              </span>
              {sw.kpMax24h != null && (
                <span style={{ opacity: 0.65 }}>
                  {' '}· max fcst{' '}
                  <span style={{ color: sw.kpMax24h >= 7 ? RED : sw.kpMax24h >= 5 ? AMBER : 'inherit' }}>
                    {sw.kpMax24h.toFixed(1)}
                  </span>
                  {sw.kpMax24h >= 5 ? ' (storm watch)' : ' (quiet)'}
                </span>
              )}
            </div>
          )}
          {sw.xrayClass && (
            <div title="GOES X-ray flux class: A/B quiet, C low, M moderate (radio blackouts), X major.">
              X-ray {sw.xrayClass}
              {sw.lastFlare && <span style={{ opacity: 0.55 }}> · last flare {sw.lastFlare}</span>}
            </div>
          )}
          {sw.windKms != null && (
            <div title="Solar wind speed at Earth; Bz strongly negative (southward) lets energy couple into the magnetosphere.">
              solar wind {sw.windKms} km/s
              {sw.windBz != null && <span style={{ opacity: 0.55 }}> · Bz {sw.windBz} nT</span>}
            </div>
          )}
          {sum?.home && (() => {
            const v = auroraVerdict(sw.kpMax24h ?? sw.kpNow, sum.home.lat, sum.home.lon);
            return v === 'none' ? (
              <div style={{ opacity: 0.45 }}>aurora: not visible at your latitude tonight</div>
            ) : (
              <div style={{ color: v === 'overhead' ? GREEN : AMBER }}>
                aurora {v === 'overhead' ? 'likely overhead' : 'possible low on the northern horizon'} — look north late
              </div>
            );
          })()}
        </Section>
      )}

      {sum?.briefing && (
        <Section
          title="BRIEFING"
          right={
            <span style={{ fontSize: 10 }}>
              <span style={{ opacity: 0.4 }}>{String(sum.briefing.date).slice(0, 10)} · </span>
              <span style={{ color: sum.briefing.quiet ? DIM : AMBER }}>
                {sum.briefing.quiet ? 'QUIET' : 'ACTIVE'}
              </span>
            </span>
          }
        >
          <div style={{ opacity: 0.9 }}>{sum.briefing.lead}</div>
          {sum.briefing.changed && (
            <div
              style={{
                opacity: 0.6,
                marginTop: 2,
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              <span style={{ color: CYAN, opacity: 0.7 }}>changed: </span>
              {sum.briefing.changed}
            </div>
          )}
          {sum.briefing.signoff && (
            <div style={{ marginTop: 4, fontStyle: 'italic', color: CYAN, opacity: 0.7 }}>
              “{sum.briefing.signoff}”
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
