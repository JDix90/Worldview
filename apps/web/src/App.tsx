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

export function App() {
  const store = useMemo(() => new AircraftStore(), []);
  const milStore = useMemo(() => new AircraftStore(), []);
  const { status } = useAircraftFeed(store, milStore);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [routeHex, setRouteHex] = useState<string | null>(null);
  const [card, setCard] = useState<LayerCard | null>(null);
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
      <FeedPanel />
      <HomeDashboard />
      <LocationChip />
      <ScreenToggle />
      <SpinToggle enabled={spinEnabled} onToggle={toggleSpin} />
      <LayersPanel defs={layerDefs} enabled={layersEnabled} onToggle={toggleLayer} />
    </>
  );
}
