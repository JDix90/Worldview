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
import { AircraftStore } from './feed/aircraftStore';
import { useAircraftFeed } from './feed/useAircraftFeed';
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
  const panelProps = (id: PanelId) => ({
    open: openPanel === id,
    onOpenChange: (v: boolean) => setOpenPanel(v ? id : null),
    chipVisible: openPanel === null,
  });
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
      />
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
      {/* Bottom-right control cluster, grouped by kind (design review #114):
          state toggles at the base, then a gap, then the four surfaces that
          open panels (they carry a › chevron). FEED moved here from its old
          orphaned top-right corner. 30px steps; 8px gap between groups. */}
      {openPanel === null && <SpinToggle enabled={spinEnabled} onToggle={toggleSpin} bottom={14} />}
      {openPanel === null && <ScreenToggle bottom={44} />}
      <LayersPanel defs={layerDefs} enabled={layersEnabled} onToggle={toggleLayer} {...panelProps('layers')} bottom={82} />
      <LocationChip {...panelProps('location')} bottom={112} />
      <HomeDashboard {...panelProps('home')} bottom={142} />
      <FeedPanel {...panelProps('feed')} bottom={172} />
    </>
  );
}
