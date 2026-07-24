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
const titleCase = (id: string) => humanize(id).replace(/\b\w/g, (c) => c.toUpperCase());
const GROUP_LABEL: Record<CrimeGroup, string> = { violent: 'Violent', property: 'Property', other: 'Other' };

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Denver Open Data stamps these as local-time-in-a-UTC-epoch (the standard
// municipal-ArcGIS convention), so getUTC* reads the true wall-clock face.
function clock(ms: number, withDate = true): string {
  const d = new Date(ms);
  let h = d.getUTCHours();
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const time = `${h}:${mm} ${ap}`;
  return withDate ? `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}` : time;
}

/** "Sat Jul 19, 9:06 PM" — or a range when the offense spans a window. */
function occurredText(inc: CrimeIncident): string | null {
  if (inc.occurredAtMs == null) return null;
  const start = clock(inc.occurredAtMs);
  if (inc.occurredEndMs == null) return start;
  const sameDay = new Date(inc.occurredAtMs).getUTCDate() === new Date(inc.occurredEndMs).getUTCDate();
  return `${start} – ${clock(inc.occurredEndMs, !sameDay)}`;
}

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

  detailCard: (item, d) => {
    const inc = item as CrimeIncident;
    const occurred = occurredText(inc);
    const block = [inc.address || 'location withheld', inc.neighborhood && titleCase(inc.neighborhood)]
      .filter(Boolean)
      .join(' · ');
    // Every offense sharing this block, newest first — the card pages them.
    const siblings = d
      .filter((i) => i.address === inc.address)
      .sort((a, b) => b.reportedAtMs - a.reportedAtMs);
    return {
      kicker: `${GROUP_LABEL[inc.group]} crime`,
      title: titleCase(inc.type),
      rows: [
        ...(occurred ? [{ label: 'occurred', value: occurred }] : []),
        { label: 'reported', value: ago(inc.reportedAtMs) },
        { label: 'block', value: block },
        ...(inc.victimCount && inc.victimCount > 1 ? [{ label: 'victims', value: String(inc.victimCount) }] : []),
      ],
      related: siblings.length > 1 ? siblings : undefined,
    };
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
