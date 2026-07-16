import { useMemo, useState } from 'react';
import { GlobeView } from './globe/GlobeView';
import { Hud } from './ui/Hud';
import { AircraftCard } from './ui/AircraftCard';
import { FeedPanel } from './ui/FeedPanel';
import { AircraftStore } from './feed/aircraftStore';
import { useAircraftFeed } from './feed/useAircraftFeed';

export function App() {
  const store = useMemo(() => new AircraftStore(), []);
  const { status } = useAircraftFeed(store);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);

  return (
    <>
      <GlobeView store={store} selectedHex={selectedHex} onSelect={setSelectedHex} />
      <Hud store={store} feedStatus={status} />
      {selectedHex && (
        <AircraftCard store={store} hex={selectedHex} onClose={() => setSelectedHex(null)} />
      )}
      <FeedPanel />
    </>
  );
}
