/**
 * CRIME — recently reported offenses (Denver Open Data, #113). First of the
 * two founding layers, re-expressed as a CityLayerDef in the round-1 refactor
 * (#125). Behavior is unchanged from the inline original.
 */
import { sourceForHome, fetchRecentCached, type CrimeIncident, type CrimeGroup } from '../../feed/crime';
import { toPx, onScreen, type CityLayerDef, type MercatorView, type CityPick } from '../registry';

export const CRIME_DAYS = 7;

const GROUP_COLOR: Record<CrimeGroup, string> = {
  violent: '#ff5a5a',
  property: '#ffb300',
  other: 'rgba(143,163,184,0.75)',
};

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const humanize = (id: string) => id.replace(/-/g, ' ');

export const crimeLayer: CityLayerDef<CrimeIncident[]> = {
  id: 'crime',
  label: 'CRIME',
  chipColor: '#ffb300',
  defaultOn: true,
  describe: `reported offenses, last ${CRIME_DAYS} days — Denver Open Data`,
  attribution: 'data: Denver Open Data (DPD, updated Mon–Fri)',

  fetchEager: async (home) => {
    const src = sourceForHome(home.lat, home.lon);
    if (!src) return [];
    return fetchRecentCached(src, home.lat, home.lon, CRIME_DAYS);
  },

  count: (d) => d.length,

  pickables: (d, view: MercatorView) =>
    d
      .map((inc) => ({ item: inc, ...toPx(view, inc.lat, inc.lon) }))
      .filter((p) => onScreen(view, p)),

  renderSvg: (d, view, picked: CityPick | null) => (
    <>
      {d.map((inc, i) => {
        const p = toPx(view, inc.lat, inc.lon);
        if (!onScreen(view, p)) return null;
        const sel = picked?.layerId === 'crime' && picked.item === inc;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={sel ? 4.5 : 3}
            fill={GROUP_COLOR[inc.group]}
            opacity={0.85}
            stroke={sel ? '#e8eef3' : 'none'}
            strokeWidth={sel ? 1.2 : 0}
          />
        );
      })}
    </>
  ),

  detail: (item, d) => {
    const inc = item as CrimeIncident;
    const stacked = d.filter((i) => i.address === inc.address).length - 1;
    return (
      <span>
        <span style={{ color: GROUP_COLOR[inc.group] }}>{humanize(inc.type)}</span>
        <span style={{ opacity: 0.65 }}>
          {' '}· {inc.address || 'location withheld'} · reported {ago(inc.reportedAtMs)}
          {stacked > 0 && ` · +${stacked} more at this block`}
        </span>
      </span>
    );
  },

  legend: (d) => {
    const c: Record<CrimeGroup, number> = { violent: 0, property: 0, other: 0 };
    for (const i of d) c[i.group]++;
    return (
      <>
        {(Object.keys(GROUP_COLOR) as CrimeGroup[]).map((g) => (
          <span key={g} style={{ fontSize: 10, opacity: 0.85 }}>
            <span style={{ color: GROUP_COLOR[g] }}>●</span> {g} {c[g]}
          </span>
        ))}
      </>
    );
  },
};
