/**
 * HOME chip — anchors the appliance display's local view ("overhead",
 * "N mi of you"). Click → an input expands beside the chip: type a city
 * ("Denver" / "Springfield MO") or US zip; Enter sets home via geocoding
 * (Open-Meteo geocoder for names, zippopotam.us for zips — both keyless,
 * CORS-open, verified live). Empty Enter keeps the old gesture: use the
 * globe camera's current center. The display re-anchors on its next poll.
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../feed/api';
import { Chip, CHIP_GREEN, CHIP_CYAN } from './Chip';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const popover: React.CSSProperties = {
  position: 'fixed',
  right: 144, // grows leftward — clears the 124px-wide chip + edge gap
  width: 240,
  padding: '8px 10px',
  font: `11px/1.6 ${mono}`,
  color: 'rgba(200,214,229,0.92)',
  background: 'rgba(6,10,16,0.92)',
  border: '1px solid rgba(79,216,255,0.25)',
  borderRadius: 4,
  backdropFilter: 'blur(4px)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  font: `12px ${mono}`,
  color: '#e6eef6',
  background: 'rgba(20,32,44,0.9)',
  border: '1px solid rgba(79,216,255,0.35)',
  borderRadius: 3,
  padding: '4px 6px',
  outline: 'none',
};

interface OrreryHandle {
  globe?: { pointOfView(): { lat: number; lng: number; altitude: number } };
}

interface GeoHit {
  lat: number;
  lon: number;
  label: string;
}

// US state abbreviations → full names, so "Springfield MO" can be resolved
// properly (Open-Meteo fuzzy-matches the raw string and picks the wrong
// Springfield otherwise — caught in verification).
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

interface GeoResult {
  latitude: number;
  longitude: number;
  name: string;
  admin1?: string;
  country_code?: string;
}

async function geocode(q: string): Promise<GeoHit | null> {
  const query = q.trim();
  if (/^\d{5}$/.test(query)) {
    try {
      const res = await fetch(`https://api.zippopotam.us/us/${query}`);
      if (res.ok) {
        const d = (await res.json()) as {
          places?: Array<{ 'place name': string; 'state abbreviation': string; latitude: string; longitude: string }>;
        };
        const p = d.places?.[0];
        if (p) {
          return {
            lat: Number(p.latitude),
            lon: Number(p.longitude),
            label: `${p['place name']}, ${p['state abbreviation']}`,
          };
        }
      }
    } catch {
      /* fall through to the name geocoder */
    }
  }

  // "Springfield MO" / "Springfield, MO" → search the name, filter by state
  const m = query.match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  const state = m ? US_STATES[m[2]!.toUpperCase()] : undefined;
  const name = state ? m![1]!.trim() : query;

  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10`,
  );
  if (!res.ok) return null;
  const d = (await res.json()) as { results?: GeoResult[] };
  const results = d.results ?? [];
  if (!results.length) return null;
  const r =
    (state && results.find((x) => x.country_code === 'US' && x.admin1 === state)) || results[0]!;
  const region = r.admin1 || r.country_code || '';
  return { lat: r.latitude, lon: r.longitude, label: region ? `${r.name}, ${region}` : r.name };
}

interface LocationChipProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chip hides while a right-dock panel is open (one surface at a time). */
  chipVisible: boolean;
  bottom: number;
}

export function LocationChip({ open, onOpenChange, chipVisible, bottom }: LocationChipProps) {
  const [current, setCurrent] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (open) {
      apiGet<{ lat: number; lon: number; label?: string }>('/api/settings/home')
        .then((h) => setCurrent(h.label ?? `${h.lat.toFixed(2)}, ${h.lon.toFixed(2)}`))
        .catch(() => setCurrent(null));
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setErr(false);
    }
  }, [open]);

  const setHome = async (lat: number, lon: number, label: string) => {
    await apiPost('/api/settings/home', { lat, lon });
    onOpenChange(false);
    setFlash(`✓ ${label}`.slice(0, 22));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), 3000);
  };

  const submit = async () => {
    const q = inputRef.current?.value ?? '';
    setErr(false);
    setBusy(true);
    try {
      if (!q.trim()) {
        const g = (window as { __ORRERY__?: OrreryHandle }).__ORRERY__?.globe;
        if (!g) return;
        const pov = g.pointOfView();
        await setHome(pov.lat, pov.lng, 'globe center');
        return;
      }
      const hit = await geocode(q);
      if (!hit) {
        setErr(true);
        return;
      }
      await setHome(hit.lat, hit.lon, hit.label);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  if (!open && !chipVisible) return null;

  return (
    <>
      {open && (
        <div style={{ ...popover, bottom: bottom - 4 }}>
          <input
            ref={inputRef}
            style={inputStyle}
            placeholder="city or US zip"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submit();
              if (e.key === 'Escape') onOpenChange(false);
            }}
          />
          <div style={{ opacity: 0.55, marginTop: 4, fontSize: 10 }}>
            {err ? (
              <span style={{ color: '#ff5a5a', opacity: 1 }}>not found — try "city ST" or a 5-digit zip</span>
            ) : busy ? (
              'looking up…'
            ) : (
              <>Enter sets home · empty = globe center{current ? <> · now: {current}</> : null}</>
            )}
          </div>
        </div>
      )}
      <Chip
        bottom={bottom}
        label={flash ? <span style={{ color: CHIP_GREEN }}>{flash}</span> : 'LOCATION'}
        state={flash ? undefined : '⌖'}
        stateColor={CHIP_CYAN}
        opens
        title="Set the home location (city/zip, or empty = globe center) — anchors the appliance display and the HOME dashboard"
        onClick={() => (flash ? undefined : onOpenChange(!open))}
      />
    </>
  );
}
