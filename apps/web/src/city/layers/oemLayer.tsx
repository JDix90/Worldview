/**
 * OEM — Denver's active emergency incidents (round 1 L3, #125). The
 * owner-approved substitute for live CAD, which Denver does not publish
 * (verified 2026-07-23 across all 1,296 ODC services). `IncidentLocations_
 * Public` is the Office of Emergency Management's *active* layer: empty on a
 * quiet day — hence exception-based, invisible until the city is responding
 * to something. Structurally verified only; the first real incident is the
 * live test (noted in DECISIONS at build).
 */
import { toPx, onScreen, type CityLayerDef, type CityPick } from '../registry';

export interface OemIncident {
  name: string;
  category: string | null;
  type: string | null;
  severity: string | null;
  reportedMs: number | null;
  lat: number;
  lon: number;
}

const OEM_URL =
  'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/IncidentLocations_Public/FeatureServer/0/query';
const ORANGE = '#ff9d4d';

async function fetchOem(): Promise<OemIncident[]> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'INCIDENTNM,CATEGORY,INCIDENTTP,REPTIME,SEVERITY,SEVDESC',
    outSR: '4326',
    f: 'json',
  });
  const res = await fetch(`${OEM_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Denver OEM: HTTP ${res.status}`);
  const d = (await res.json()) as {
    error?: unknown;
    features?: Array<{ attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number } }>;
  };
  if (d.error) throw new Error('Denver OEM: query error');
  const out: OemIncident[] = [];
  for (const f of d.features ?? []) {
    const a = f.attributes ?? {};
    const g = f.geometry;
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) continue;
    out.push({
      name: String(a.INCIDENTNM ?? 'incident'),
      category: a.CATEGORY != null ? String(a.CATEGORY) : null,
      type: a.INCIDENTTP != null ? String(a.INCIDENTTP) : null,
      severity: a.SEVDESC != null ? String(a.SEVDESC) : null,
      reportedMs: typeof a.REPTIME === 'number' ? a.REPTIME : null,
      lon: g.x!,
      lat: g.y!,
    });
  }
  return out;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const oemLayer: CityLayerDef<OemIncident[]> = {
  id: 'oem',
  label: 'OEM',
  chipColor: ORANGE,
  defaultOn: true,
  describe: 'Denver OEM active emergency incidents — empty when the city is quiet',
  attribution: 'incidents: Denver OEM',

  fetchEager: () => fetchOem(),
  pollWhileOpenMs: 2 * 60_000,

  count: (d) => d.length,
  hasContent: (d) => d.length > 0,

  pickables: (d, view) =>
    d.map((inc) => ({ item: inc, ...toPx(view, inc.lat, inc.lon) })).filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.map((inc, i) => {
        const p = toPx(view, inc.lat, inc.lon);
        if (!onScreen(view, p)) return null;
        const sel = picked?.layerId === 'oem' && picked.item === inc;
        const s = sel ? 5.5 : 4.5;
        return (
          <rect
            key={i}
            x={-s / Math.SQRT2}
            y={-s / Math.SQRT2}
            width={(2 * s) / Math.SQRT2}
            height={(2 * s) / Math.SQRT2}
            transform={`translate(${p.x} ${p.y}) rotate(45)`}
            fill={ORANGE}
            opacity={0.95}
            stroke={sel ? '#e8eef3' : 'rgba(0,0,0,0.5)'}
            strokeWidth={sel ? 1.4 : 0.8}
          />
        );
      })}
    </>
  ),

  detail: (item) => {
    const inc = item as OemIncident;
    return (
      <span>
        <span style={{ color: ORANGE }}>◆ {inc.name}</span>
        <span style={{ opacity: 0.65 }}>
          {inc.category && ` · ${inc.category}`}
          {inc.severity && ` · ${inc.severity}`}
          {inc.reportedMs && ` · reported ${ago(inc.reportedMs)}`}
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: ORANGE }}>◆</span> OEM {d.length} active
    </span>
  ),
};
