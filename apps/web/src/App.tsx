import { useCallback, useMemo, useState } from 'react';
import { GlobeView } from './globe/GlobeView';
import { Hud } from './ui/Hud';
import { AircraftCard } from './ui/AircraftCard';
import { FeedPanel } from './ui/FeedPanel';
import { LayersPanel } from './ui/LayersPanel';
import { ObjectCard } from './ui/ObjectCard';
import { SpinToggle } from './ui/SpinToggle';
import { ScreenToggle } from './ui/ScreenToggle';
import { LocationChip } from './ui/LocationChip';
import { HomeDashboard } from './ui/HomeDashboard';
import { FlightSearch } from './ui/FlightSearch';
import { CityMap } from './ui/CityMap';
import { CityLayersPanel } from './ui/CityLayersPanel';
import { Chip } from './ui/Chip';
import { useNarrow } from './ui/uiKit';
import { AircraftStore } from './feed/aircraftStore';
import { useAircraftFeed } from './feed/useAircraftFeed';
import { useCityMap } from './feed/useCityMap';
import { cityLayerDefs } from './city/layers';
import { useLoiterWatch } from './city/useLoiterWatch';
import { buildLayerDefs } from './layers';
import { loadEnabled, saveEnabled, type LayerCard } from './layers/registry';
import { loadPrefs, savePrefs } from './prefs';

/** The right edge hosts four surfaces (feed, home, location, layers). One at
 *  a time: they used to overlap each other and the chip stack (fresh-eyes
 *  review, 2026-07-22 / DECISIONS #109). */
type PanelId = 'feed' | 'home' | 'location' | 'layers';

export function App() {
  const store = useMemo(() => new AircraftStore(), []);
  const milStore = useMemo(() => new AircraftStore(), []);
  const { status } = useAircraftFeed(store, milStore);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [routeHex, setRouteHex] = useState<string | null>(null);
  const [card, setCard] = useState<LayerCard | null>(null);
  const [openPanel, setOpenPanel] = useState<PanelId | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const panelProps = (id: PanelId) => ({
    open: openPanel === id,
    onOpenChange: (v: boolean) => setOpenPanel(v ? id : null),
    chipVisible: openPanel === null,
  });
  // CITY map (crime + cameras) — owned here so the bottom-right CITY chip and
  // the HOME dashboard's CITY section share one modal and one fetch (#124).
  const city = useCityMap();
  // CITY is a full-viewport takeover now (#127), not an overlay: when it's up
  // the globe pauses (hidden, no render, camera state preserved) and the whole
  // chip cluster steps aside so the map owns the screen.
  const cityFull = city.open && !!city.home && city.covered;
  const openCity = useCallback(() => {
    setOpenPanel(null); // a full-screen map over an open right-edge panel reads as a bug
    city.setOpen(true);
  }, [city]);

  // Cluster rhythm — two groups (state toggles · surfaces) up the right edge.
  // Widened on phones so the taller touch-sized chips (#133) don't collide;
  // both views use the same slots, so shared chips never jump between views.
  const narrow = useNarrow();
  const STEP = narrow ? 38 : 30;
  const GAP = narrow ? 12 : 8; // extra gap between the two groups
  const tog = (i: number) => 14 + i * STEP; // toggles (SPIN/SCREEN)
  const srf = (j: number) => 14 + 2 * STEP + GAP + j * STEP; // surfaces
  // Loiter watch samples the live stores continuously (#125) — the ring
  // buffer must predate opening the map for "why is that helicopter
  // circling?" to have an answer on arrival.
  useLoiterWatch(store, milStore, city.covered ? city.home : null, city.setLayerData);
  const [spinEnabled, setSpinEnabled] = useState(() => loadPrefs().spinEnabled);
  const toggleSpin = useCallback(() => {
    setSpinEnabled((prev) => {
      const next = !prev;
      savePrefs({ ...loadPrefs(), spinEnabled: next });
      return next;
    });
  }, []);

  const layerDefs = useMemo(() => buildLayerDefs({ milStore }), [milStore]);
  const [layersEnabled, setLayersEnabled] = useState(() => loadEnabled(layerDefs));
  const toggleLayer = useCallback(
    (id: string) => {
      setLayersEnabled((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveEnabled(layerDefs, next);
        return next;
      });
    },
    [layerDefs],
  );

  // one detail surface at a time: an aircraft selection closes a layer card
  // and vice versa
  const handleSelect = useCallback((hex: string | null) => {
    setSelectedHex(hex);
    setRouteHex(null); // a new selection hides the previous flight's path
    if (hex !== null) setCard(null);
  }, []);
  const handleCard = useCallback((c: LayerCard | null) => {
    setCard(c);
    if (c !== null) setSelectedHex(null);
  }, []);
  // Search-select shows the path immediately: the reason you type a flight
  // number is to see where it's been and where it's going. Plain globe
  // clicks keep the path off until asked (handleSelect above).
  const handleSearchSelect = useCallback((hex: string) => {
    setSelectedHex(hex);
    setRouteHex(hex);
    setCard(null);
  }, []);

  return (
    <>
      <GlobeView
        store={store}
        selectedHex={selectedHex}
        onSelect={handleSelect}
        layerDefs={layerDefs}
        layersEnabled={layersEnabled}
        setCard={handleCard}
        spinEnabled={spinEnabled}
        routeHex={routeHex}
        paused={cityFull}
      />
      {/* Globe-only overlays (HUD, search, aircraft/object cards) are hidden
          while CITY owns the viewport — the map is a full takeover (#127). The
          control CLUSTER below is NOT hidden: it stays put and re-contents, so
          navigation lives in the same corner in both views (#132). */}
      {!cityFull && (
        <>
          <Hud store={store} feedStatus={status} />
          {selectedHex && (
            <AircraftCard
              store={store}
              hex={selectedHex}
              onClose={() => setSelectedHex(null)}
              routeShown={routeHex === selectedHex}
              onToggleRoute={() => setRouteHex((r) => (r === selectedHex ? null : selectedHex))}
            />
          )}
          {card && !selectedHex && <ObjectCard card={card} onClose={() => setCard(null)} />}
        </>
      )}
      {cityFull && <CityMap city={city} defs={cityLayerDefs} onClose={() => city.setOpen(false)} />}

      {/* ── the bottom-right control cluster (both views, #132) ────────────
          Shared surfaces (LOCATION/HOME/FEED) keep their exact position across
          views so nothing jumps. Globe-specific chips (SPIN/SCREEN, globe
          LAYERS, CITY-enter, SEARCH) show only on the globe; CITY swaps in a
          GLOBE-back chip *where the CITY chip was* and its own LAYERS panel —
          same place, inverse action. Grouped by kind (design review #114). */}
      {!cityFull ? (
        <>
          <FlightSearch store={store} milStore={milStore} onSelect={handleSearchSelect} open={searchOpen} onOpenChange={setSearchOpen} />
          {openPanel === null && <SpinToggle enabled={spinEnabled} onToggle={toggleSpin} bottom={tog(0)} />}
          {openPanel === null && <ScreenToggle bottom={tog(1)} />}
          <LayersPanel defs={layerDefs} enabled={layersEnabled} onToggle={toggleLayer} {...panelProps('layers')} bottom={srf(0)} />
          <LocationChip {...panelProps('location')} bottom={srf(1)} />
          <HomeDashboard {...panelProps('home')} bottom={srf(2)} city={city} onOpenCity={openCity} />
          {openPanel === null && city.covered && (
            <Chip bottom={srf(3)} label="CITY" opens title="Recent crime + mapped cameras near home" onClick={openCity} />
          )}
          <FeedPanel {...panelProps('feed')} bottom={srf(4)} />
          {openPanel === null && (
            <Chip bottom={srf(5)} label="SEARCH" state="/" opens title="Find a flight by callsign or hex ( / )" onClick={() => setSearchOpen(true)} />
          )}
        </>
      ) : (
        <>
          <CityLayersPanel defs={cityLayerDefs} city={city} {...panelProps('layers')} bottom={srf(0)} />
          <LocationChip {...panelProps('location')} bottom={srf(1)} />
          <HomeDashboard {...panelProps('home')} bottom={srf(2)} city={city} onOpenCity={openCity} />
          {openPanel === null && (
            <Chip bottom={srf(3)} label="‹ GLOBE" opens title="Back to the globe (Esc)" onClick={() => city.setOpen(false)} />
          )}
          <FeedPanel {...panelProps('feed')} bottom={srf(4)} />
        </>
      )}
    </>
  );
}
