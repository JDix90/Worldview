/**
 * ALERTS — NWS warning/watch polygons over the city (round 1 L2, #125).
 * The actual *shape* of a tornado / flash-flood / severe-thunderstorm alert,
 * not a text line. Same api.weather.gov endpoint the dashboard already
 * fetches; exception-based — no active alerts ⇒ no chip, no draw.
 * Zone-based alerts without polygon geometry are counted in the legend but
 * cannot be drawn (honest label rather than fake shapes).
 */
import { toPx, type CityLayerDef, type CityPick, type MercatorView } from '../registry';

export interface NwsAlert {
  event: string;
  severity: string;
  headline: string | null;
  until: string | null;
  sender: string | null;
  /** [ [ [lon,lat], … ] ] outer ring(s); empty = zone-based, undrawable. */
  rings: number[][][];
}

interface AlertsData {
  alerts: NwsAlert[];
  undrawable: number;
}

const RED = '#ff5a5a';
const AMBER = '#ffb300';

function colorOf(a: NwsAlert): string {
  const sev = a.severity.toLowerCase();
  const warning = /warning/i.test(a.event);
  return sev === 'extreme' || (sev === 'severe' && warning) ? RED : AMBER;
}

async function fetchAlerts(home: { lat: number; lon: number }): Promise<AlertsData> {
  const res = await fetch(
    `https://api.weather.gov/alerts/active?point=${home.lat.toFixed(4)},${home.lon.toFixed(4)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`NWS alerts: HTTP ${res.status}`);
  const d = (await res.json()) as {
    features?: Array<{
      geometry?: { type: string; coordinates: unknown } | null;
      properties?: { event?: string; severity?: string; headline?: string; ends?: string; expires?: string; senderName?: string };
    }>;
  };
  const alerts: NwsAlert[] = [];
  let undrawable = 0;
  for (const f of d.features ?? []) {
    const p = f.properties ?? {};
    let rings: number[][][] = [];
    const g = f.geometry;
    if (g?.type === 'Polygon') rings = g.coordinates as number[][][];
    else if (g?.type === 'MultiPolygon') rings = (g.coordinates as number[][][][]).map((poly) => poly[0]!);
    if (rings.length === 0) undrawable++;
    const end = p.ends || p.expires || null;
    alerts.push({
      event: p.event ?? 'Alert',
      severity: p.severity ?? '',
      headline: p.headline ?? null,
      until: end ? end.slice(11, 16) : null,
      sender: p.senderName ?? null,
      rings,
    });
  }
  return { alerts, undrawable };
}

/** Ring centroid (average of vertices — fine for a pick anchor). */
function centroid(ring: number[][]): { lat: number; lon: number } {
  let lat = 0, lon = 0;
  for (const [x, y] of ring as [number, number][]) { lon += x; lat += y; }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

export const alertsLayer: CityLayerDef<AlertsData> = {
  id: 'alerts',
  label: 'ALERTS',
  chipColor: RED,
  defaultOn: true,
  describe: 'active NWS warnings/watches — drawn as their real polygons',
  attribution: 'alerts: NWS',

  fetchEager: fetchAlerts,
  pollWhileOpenMs: 3 * 60_000,

  count: (d) => d.alerts.length,
  hasContent: (d) => d.alerts.length > 0,

  pickables: (d, view: MercatorView) =>
    d.alerts
      .filter((a) => a.rings.length > 0)
      .map((a) => {
        const c = centroid(a.rings[0]!);
        return { item: a, ...toPx(view, c.lat, c.lon) };
      }),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.alerts.map((a, i) =>
        a.rings.map((ring, j) => {
          const pts = ring.map(([lon, lat]) => toPx(view, lat!, lon!));
          const path = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z';
          const sel = picked?.layerId === 'alerts' && picked.item === a;
          const col = colorOf(a);
          return (
            <path
              key={`${i}-${j}`}
              d={path}
              fill={col}
              fillOpacity={0.12}
              stroke={col}
              strokeWidth={sel ? 2.5 : 1.5}
              strokeOpacity={0.8}
            />
          );
        }),
      )}
    </>
  ),

  detail: (item) => {
    const a = item as NwsAlert;
    return (
      <span>
        <span style={{ color: colorOf(a) }}>⚠ {a.event}</span>
        <span style={{ opacity: 0.65 }}>
          {a.until && ` · until ${a.until}`}
          {a.sender && ` · ${a.sender}`}
        </span>
      </span>
    );
  },

  legend: (d) => (
    <span style={{ fontSize: 10, opacity: 0.85 }}>
      <span style={{ color: RED }}>⚠</span> {d.alerts.length} active
      {d.undrawable > 0 && <span style={{ opacity: 0.55 }}> · {d.undrawable} zone-based (not drawable)</span>}
    </span>
  ),
};
