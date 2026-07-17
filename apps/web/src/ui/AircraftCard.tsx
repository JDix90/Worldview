/**
 * Selected-aircraft readout. Data refreshes at 1Hz — the card shows the
 * reported state and its age; the marker on the globe is what interpolates.
 * Visual pattern matches ObjectCard (label column, note line, 320 cap).
 *
 * FROM/TO come from the per-callsign route cache (feed/routes); a button
 * toggles the great-circle path overlay (RouteLayer) on the globe.
 */
import { useEffect, useState } from 'react';
import type { AircraftStore, Tracked } from '../feed/aircraftStore';
import { agoShort, compass16, ftFromM, ktMph, squawkNote, MS_TO_KT, MS_TO_FPM } from '../format';
import { airlineFromCallsign, CATEGORY_WORDS } from '../data/airlines';
import { fetchRoute, type FlightRoute, type RouteEndpoint } from '../feed/routes';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const panel: React.CSSProperties = {
  position: 'fixed',
  bottom: 14,
  left: 12,
  minWidth: 230,
  maxWidth: 320,
  padding: '10px 12px',
  font: `11px/1.6 ${mono}`,
  color: 'rgba(200, 214, 229, 0.92)',
  background: 'rgba(6, 10, 16, 0.88)',
  border: '1px solid rgba(79, 216, 255, 0.25)',
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
};

function row(label: string, value: string): JSX.Element {
  return (
    <div key={label} style={{ display: 'flex', gap: 10 }}>
      <span style={{ opacity: 0.5, minWidth: 100 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** "Phoenix (PHX)" — falls back to the airport name or ICAO if a field is blank. */
function endpointLabel(a: RouteEndpoint): string {
  const place = a.city || a.name || a.icao || 'unknown';
  return a.iata ? `${place} (${a.iata})` : place;
}

export function AircraftCard({
  store,
  hex,
  onClose,
  routeShown,
  onToggleRoute,
}: {
  store: AircraftStore;
  hex: string;
  onClose: () => void;
  routeShown: boolean;
  onToggleRoute: () => void;
}) {
  const [tracked, setTracked] = useState<Tracked | null>(() => store.byHex.get(hex) ?? null);
  const [route, setRoute] = useState<FlightRoute | null | 'loading'>('loading');

  useEffect(() => {
    setTracked(store.byHex.get(hex) ?? null);
    const id = setInterval(() => setTracked(store.byHex.get(hex) ?? null), 1000);
    return () => clearInterval(id);
  }, [store, hex]);

  // one route lookup per selected aircraft (cached per callsign)
  const callsign = store.byHex.get(hex)?.state.callsign;
  useEffect(() => {
    let cancelled = false;
    setRoute('loading');
    void fetchRoute(callsign).then((r) => {
      if (!cancelled) setRoute(r);
    });
    return () => {
      cancelled = true;
    };
  }, [callsign]);

  if (!tracked) return null;
  const s = tracked.state;
  const lost = tracked.missingSinceMs !== null;

  const airline = airlineFromCallsign(s.callsign);
  const catWords = s.category !== undefined ? CATEGORY_WORDS[s.category] : undefined;
  const note =
    airline && catWords ? `${airline} — ${catWords}`
    : airline ? `${airline} flight`
    : catWords ? `Civil traffic — ${catWords}`
    : undefined;
  const hasRoute = route !== null && route !== 'loading';

  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: '#4fd8ff', fontWeight: 600, letterSpacing: 1 }}>
          {s.callsign ?? '(no callsign)'}
        </span>
        <span style={{ opacity: 0.55 }}>civil aircraft</span>
        <span style={{ flex: 1 }} />
        <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6, pointerEvents: 'auto' }} title="deselect">
          ✕
        </span>
      </div>
      {note && <div style={{ marginTop: 5, opacity: 0.75, lineHeight: 1.45 }}>{note}</div>}
      <div style={{ marginTop: 6 }}>
        {hasRoute && row('FROM', endpointLabel(route.origin))}
        {hasRoute && row('TO', endpointLabel(route.destination))}
        {s.altBaroM !== undefined && row('ALTITUDE', ftFromM(s.altBaroM))}
        {s.groundSpeedMs !== undefined && row('SPEED', ktMph(s.groundSpeedMs * MS_TO_KT))}
        {s.trackDeg !== undefined && row('HEADING', `${Math.round(s.trackDeg)}° ${compass16(s.trackDeg)}`)}
        {s.verticalRateMs !== undefined &&
          row(
            'CLIMB',
            `${s.verticalRateMs >= 0 ? '+' : ''}${Math.round(s.verticalRateMs * MS_TO_FPM).toLocaleString()} ft/min`,
          )}
        {s.squawk !== undefined && row('SQUAWK', `${s.squawk}${squawkNote(s.squawk)}`)}
        {s.originCountry !== undefined && row('REGISTRY', s.originCountry)}
        {row('SEEN', agoShort(s.seenAt * 1000))}
        {row('HEX', s.hex)}
      </div>
      {hasRoute && (
        <div
          onClick={onToggleRoute}
          style={{
            marginTop: 8,
            padding: '4px 0',
            textAlign: 'center',
            cursor: 'pointer',
            color: routeShown ? '#06121c' : '#4fd8ff',
            background: routeShown ? '#4fd8ff' : 'transparent',
            border: '1px solid rgba(79,216,255,0.5)',
            borderRadius: 3,
            letterSpacing: 1,
            userSelect: 'none',
          }}
        >
          {routeShown ? 'HIDE FLIGHT PATH' : 'SHOW FLIGHT PATH'}
        </div>
      )}
      {route === 'loading' && (
        <div style={{ marginTop: 8, opacity: 0.4, fontSize: 10 }}>checking route…</div>
      )}
      {route === null && (
        <div style={{ marginTop: 8, opacity: 0.4, fontSize: 10 }}>no scheduled route on file</div>
      )}
      {lost && (
        <div style={{ marginTop: 6, color: '#ffb300' }}>SIGNAL LOST — holding last vector</div>
      )}
    </div>
  );
}
