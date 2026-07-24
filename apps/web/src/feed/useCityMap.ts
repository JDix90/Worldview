/**
 * Shared owner of the CITY map's data + open state (#124), generalized for
 * the round-1 layer framework (#125): per-layer data states driven by the
 * CityLayerDef registry — eager fetches at load (cheap counts for chips and
 * the dashboard section) and poll-while-open cadences for live layers, with
 * intervals cleared the moment the modal closes.
 *
 * Independence law (#122): each layer fetches, caches, and fails alone.
 * Home comes from the lightweight /api/settings/home so the CITY chip works
 * without the HOME panel's heavier pager-summary fetch.
 */
import { useEffect, useRef, useState } from 'react';
import { apiGet } from './api';
import { sourceForHome, type CrimeIncident, type CrimeSource } from './crime';
import type { AlprCamera } from './alpr';
import { cityLayerDefs } from '../city/layers';
import type { LayerData } from '../city/registry';

export { CRIME_DAYS } from '../city/layers/crimeLayer';

export interface CityMapState {
  home: { lat: number; lon: number } | null;
  /** Nearest-city label, e.g. "Denver, US". */
  label: string;
  source: CrimeSource | null;
  /** True when home is in a covered city — gates the chip and section. */
  covered: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  /** Per-layer data keyed by CityLayerDef id. */
  data: Record<string, LayerData<unknown>>;
  /** Push-style layers (e.g. loiter) write their state here. */
  setLayerData: (id: string, d: LayerData<unknown>) => void;
  // Typed conveniences for the dashboard section:
  crime: LayerData<CrimeIncident[]>;
  alpr: LayerData<AlprCamera[]>;
}

export function useCityMap(): CityMapState {
  const [home, setHome] = useState<{ lat: number; lon: number } | null>(null);
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Record<string, LayerData<unknown>>>({});
  const timers = useRef<number[]>([]);

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
    const id = window.setInterval(load, 5 * 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const source = home ? sourceForHome(home.lat, home.lon) : null;
  const covered = !!source;
  const homeKey = home ? `${home.lat},${home.lon}` : '';

  const setLayerData = (id: string, d: LayerData<unknown>) => setData((prev) => ({ ...prev, [id]: d }));

  // One fetch runner per layer; used by both eager and poll paths.
  const runFetch = (id: string, fn: () => Promise<unknown>, alive: () => boolean) =>
    fn()
      .then((d) => alive() && setLayerData(id, d as LayerData<unknown>))
      .catch(() => alive() && setLayerData(id, 'unavailable'));

  // Eager fetches: once per home change, for every def that declares one.
  useEffect(() => {
    if (!home || !covered) { setData({}); return; }
    let live = true;
    const alive = () => live;
    for (const def of cityLayerDefs) {
      if (!def.fetchEager) continue;
      setLayerData(def.id, null);
      void runFetch(def.id, () => def.fetchEager!(home), alive);
    }
    return () => { live = false; };
  }, [homeKey, covered]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll-while-open: live layers re-fetch on their cadence ONLY while the
  // modal is showing; every interval dies on close (#125 — the eager-load
  // trade-off of #124 must not multiply by the layer count).
  useEffect(() => {
    if (!open || !home || !covered) return;
    let live = true;
    const alive = () => live;
    for (const def of cityLayerDefs) {
      if (!def.pollWhileOpenMs || !def.fetchEager) continue;
      const t = window.setInterval(
        () => void runFetch(def.id, () => def.fetchEager!(home), alive),
        def.pollWhileOpenMs,
      );
      timers.current.push(t);
    }
    return () => {
      live = false;
      timers.current.forEach((t) => window.clearInterval(t));
      timers.current = [];
    };
  }, [open, homeKey, covered]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    home,
    label,
    source,
    covered,
    open,
    setOpen,
    data,
    setLayerData,
    crime: (data['crime'] ?? null) as LayerData<CrimeIncident[]>,
    alpr: (data['cameras'] ?? null) as LayerData<AlprCamera[]>,
  };
}
