/**
 * 311 — what neighbors are reporting (round 1 L6, #125). Denver's service-
 * request table, last 7 days, city bbox. Freshness-gated at build time per
 * the round-1 plan: 6,393 rows in the trailing week on 2026-07-23, so the
 * earlier stale-looking sample was OBJECTID ordering, not a dead feed.
 * Default OFF — neighborhood texture, not ambient hazard. Client-direct
 * (same ArcGIS host as crime; CORS known-good).
 */
import { toPx, onScreen, type CityLayerDef, type CityPick, type MercatorView } from '../registry';

export interface ThreeOneOne {
  summary: string;
  status: string | null;
  agency: string | null;
  address: string | null;
  createdMs: number | null;
  lat: number;
  lon: number;
}

interface Data311 {
  rows: ThreeOneOne[];
  capped: boolean;
}

const URL311 =
  'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/ODC_service_requests_311/FeatureServer/66/query';
const GREEN = '#8fd6a8';
const CAP = 1500;
const DAYS = 7;

async function fetch311(home: { lat: number; lon: number }): Promise<Data311> {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const where =
    `Case_Created_Date >= DATE '${since}'` +
    ` AND Latitude >= ${home.lat - 0.12} AND Latitude <= ${home.lat + 0.12}` +
    ` AND Longitude >= ${home.lon - 0.15} AND Longitude <= ${home.lon + 0.15}`;
  const params = new URLSearchParams({
    where,
    outFields: 'Case_Summary,Case_Status,Agency,Incident_Address_1,Case_Created_dttm,Latitude,Longitude',
    orderByFields: 'Case_Created_Date DESC',
    resultRecordCount: String(CAP),
    f: 'json',
  });
  const res = await fetch(`${URL311}?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Denver 311: HTTP ${res.status}`);
  const d = (await res.json()) as {
    error?: unknown;
    exceededTransferLimit?: boolean;
    features?: Array<{ attributes?: Record<string, unknown> }>;
  };
  if (d.error) throw new Error('Denver 311: query error');
  const rows: ThreeOneOne[] = [];
  for (const f of d.features ?? []) {
    const a = f.attributes ?? {};
    const lat = Number(a.Latitude), lon = Number(a.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) continue;
    const created = Date.parse(String(a.Case_Created_dttm ?? ''));
    rows.push({
      summary: String(a.Case_Summary ?? 'request'),
      status: a.Case_Status != null ? String(a.Case_Status) : null,
      agency: a.Agency != null ? String(a.Agency) : null,
      address: a.Incident_Address_1 != null ? String(a.Incident_Address_1) : null,
      createdMs: Number.isFinite(created) ? created : null,
      lat,
      lon,
    });
  }
  return { rows, capped: rows.length >= CAP || !!d.exceededTransferLimit };
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const threeOneOneLayer: CityLayerDef<Data311> = {
  id: '311',
  label: '311',
  chipColor: GREEN,
  defaultOn: false,
  describe: `neighbor reports (potholes, noise, fireworks…) — last ${DAYS} days, Denver 311`,
  attribution: '311: Denver Open Data',

  fetchEager: fetch311,
  // Daily-ish data; no while-open poll needed.

  count: (d) => d.rows.length,

  pickables: (d, view: MercatorView) =>
    d.rows.map((r) => ({ item: r, ...toPx(view, r.lat, r.lon) })).filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.rows.map((r, i) => {
        const p = toPx(view, r.lat, r.lon);
        if (!onScreen(view, p)) return null;
        const sel = picked?.layerId === '311' && picked.item === r;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={sel ? 3.5 : 1.8}
            fill={GREEN}
            opacity={0.55}
            stroke={sel ? '#e8eef3' : 'none'}
            strokeWidth={sel ? 1 : 0}
          />
        );
      })}
    </>
  ),

  detail: (item) => {
    const r = item as ThreeOneOne;
    return (
      <span>
        <span style={{ color: GREEN }}>{r.summary}</span>
        <span style={{ opacity: 0.65 }}>
          {r.address && ` · ${r.address}`}
          {r.status && ` · ${r.status}`}
          {r.agency && ` · ${r.agency}`}
          {r.createdMs && ` · ${ago(r.createdMs)}`}
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: GREEN }}>●</span> 311 {d.rows.length}
      {d.capped && <span style={{ opacity: 0.55 }}> (latest {CAP})</span>}
    </span>
  ),
};
