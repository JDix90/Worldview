/**
 * Shared owner of the CITY map's data + open state (DECISIONS #124). Lives in
 * App so two entry points — the bottom-right CITY chip and the HOME dashboard's
 * CITY section — read one source of truth and one modal, rather than each
 * holding its own copy (which double-owns the open state and can desync the
 * counts). The feed caches (fetchRecentCached / fetchAlprCached) dedupe the
 * network, so a single owner also means a single request.
 *
 * Home comes from the lightweight /api/settings/home (lat/lon/label) so the
 * chip works without the HOME panel's heavier pager-summary fetch.
 */
import { useEffect, useState } from 'react';
import { apiGet } from './api';
import { sourceForHome, fetchRecentCached, type CrimeIncident, type CrimeSource } from './crime';
import { fetchAlprCached, type AlprCamera } from './alpr';

export const CRIME_DAYS = 7;

/** null = still loading · 'unavailable' = upstream failed · array = data. */
export type CrimeState = CrimeIncident[] | 'unavailable' | null;
export type AlprState = AlprCamera[] | 'unavailable' | null;

export interface CityMap {
  home: { lat: number; lon: number } | null;
  /** Nearest-city label, e.g. "Denver, US". */
  label: string;
  source: CrimeSource | null;
  crime: CrimeState;
  alpr: AlprState;
  /** True when home is in a covered city — gates the chip and section. */
  covered: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
}

export function useCityMap(): CityMap {
  const [home, setHome] = useState<{ lat: number; lon: number } | null>(null);
  const [label, setLabel] = useState('');
  const [crime, setCrime] = useState<CrimeState>(null);
  const [alpr, setAlpr] = useState<AlprState>(null);
  const [open, setOpen] = useState(false);

  // Home, refreshed on an interval so a LOCATION change re-homes the map too.
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<{ lat: number; lon: number; label?: string }>('/api/settings/home')
        .then((h) => {
          if (!alive || typeof h.lat !== 'number' || typeof h.lon !== 'number') return;
          setHome((prev) => (prev && prev.lat === h.lat && prev.lon === h.lon ? prev : { lat: h.lat, lon: h.lon }));
          setLabel(h.label ?? '');
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const source = home ? sourceForHome(home.lat, home.lon) : null;
  const homeKey = home ? `${home.lat},${home.lon}` : '';

  useEffect(() => {
    if (!home || !source) { setCrime(null); return; }
    let alive = true;
    setCrime(null);
    fetchRecentCached(source, home.lat, home.lon, CRIME_DAYS)
      .then((d) => alive && setCrime(d))
      .catch(() => alive && setCrime('unavailable'));
    return () => { alive = false; };
  }, [homeKey, source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!home || !source) { setAlpr(null); return; }
    let alive = true;
    setAlpr(null);
    fetchAlprCached(home.lat, home.lon)
      .then((d) => alive && setAlpr(d))
      .catch(() => alive && setAlpr('unavailable'));
    return () => { alive = false; };
  }, [homeKey, source]); // eslint-disable-line react-hooks/exhaustive-deps

  return { home, label, source, crime, alpr, covered: !!source, open, setOpen };
}
