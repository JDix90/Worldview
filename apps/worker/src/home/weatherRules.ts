/**
 * Weather and air rules for the home briefing (FOUNDATION §12, DECISIONS #143
 * c–d, #148). Pure functions shared by the live detector (weather.ts) and the
 * backtest (scripts/backtestHomeBriefing.ts), so the rules that were measured
 * are the rules that run.
 */

// ── thresholds (#143 c) ───────────────────────────────────────────────────
/** ≥95 °F fired on 11 of the backtest's August–September days: ordinary
 *  Denver summer. 100 °F is where heat becomes news. */
export const HEAT_F = 100;
export const FREEZE_F = 32;
export const HARD_FREEZE_F = 25;
export const FIRST_SNOW_IN = 0.5;
export const HEAVY_SNOW_IN = 3;
/** A drop in the daily high this big from one day to the next. */
export const FRONT_DROP_F = 25;
export const GUST_MPH = 50;
export const HEAVY_RAIN_IN = 1;
/** "Unhealthy for sensitive groups" on the US AQI scale. */
export const AQI_UNHEALTHY_SG = 101;

// ── NWS alerts ────────────────────────────────────────────────────────────
export interface Vtec {
  action: string;
  office: string;
  phen: string;
  sig: string;
  etn: string;
}

/** P-VTEC, e.g. "/O.NEW.KBOU.WS.W.0005.261110T0000Z-261111T0000Z/". */
export function parseVtec(s: string): Vtec | null {
  const m = /\/[OTEX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([WAYSFON])\.(\d{4})\./.exec(s);
  return m ? { action: m[1]!, office: m[2]!, phen: m[3]!, sig: m[4]!, etn: m[5]! } : null;
}

/** Warnings and advisories that reach home, minus dense fog (morning fog
 *  isn't news, #143 c). Watches stay out, as in the backtest's set. */
export function keepAlert(phen: string, sig: string): boolean {
  return (sig === 'W' || sig === 'Y') && phen !== 'FG';
}

/** Alerts without VTEC (an Air Quality Alert, for one) are judged by name. */
export function keepAlertByName(event: string): boolean {
  return (/(warning|advisory)$/i.test(event.trim()) || /^air quality alert$/i.test(event.trim())) && !/dense fog/i.test(event);
}

// ── forecast days ─────────────────────────────────────────────────────────
export interface DayWx {
  date: string;
  hi: number;
  lo: number;
  snow: number;
  rain: number;
  gust: number;
  /** The previous day's high, for the cold-front rule. */
  prevHi: number;
}
/** Which season firsts have already happened. */
export interface SeasonState {
  freeze: boolean;
  hardFreeze: boolean;
  snow: boolean;
}
export interface WxFinding {
  rule: 'wx.first' | 'wx.extreme';
  /** first-freeze | first-hard-freeze | first-snow | snow | heat | front | wind | rain */
  kind: string;
  /** Short form for a note's lead line. */
  label: string;
  /** The note's line for it. */
  line: string;
  date: string;
}

const f0 = (v: number) => v.toFixed(0);
const f1 = (v: number) => v.toFixed(1);

/** One day's findings. Season firsts fire once per season: the caller carries
 *  the state (the backtest in memory, the live detector from its events).
 *  `loWhen` names when the low happens ("tonight" for a morning note). NaN
 *  (missing data) never fires anything. */
export function dayFindings(d: DayWx, season: SeasonState, loWhen = ''): { findings: WxFinding[]; season: SeasonState } {
  const out: WxFinding[] = [];
  const s = { ...season };
  const at = loWhen ? ` ${loWhen}` : '';
  const add = (rule: WxFinding['rule'], kind: string, label: string, line: string) =>
    out.push({ rule, kind, label, line, date: d.date });
  if (!s.freeze && d.lo <= FREEZE_F) {
    s.freeze = true;
    add('wx.first', 'first-freeze', `first freeze${at}`, `First freeze of the season${at}: low ${f0(d.lo)}°F`);
  }
  if (!s.hardFreeze && d.lo <= HARD_FREEZE_F) {
    s.hardFreeze = true;
    add('wx.first', 'first-hard-freeze', `first hard freeze${at}`, `First hard freeze of the season${at}: low ${f0(d.lo)}°F`);
  }
  if (!s.snow && d.snow >= FIRST_SNOW_IN) {
    s.snow = true;
    add('wx.first', 'first-snow', 'first snow', `First snow of the season: ${f1(d.snow)} in`);
  } else if (season.snow && d.snow >= HEAVY_SNOW_IN) {
    add('wx.extreme', 'snow', `${f1(d.snow)} in of snow`, `Snow: ${f1(d.snow)} in`);
  }
  if (d.hi >= HEAT_F) add('wx.extreme', 'heat', `${f0(d.hi)}°F heat`, `Heat: high ${f0(d.hi)}°F`);
  if (d.prevHi - d.hi >= FRONT_DROP_F) {
    add('wx.extreme', 'front', 'cold front',
      `Cold front: high ${f0(d.hi)}°F, ${f0(d.prevHi - d.hi)}° colder than the day before`);
  }
  if (d.gust >= GUST_MPH) add('wx.extreme', 'wind', `gusts to ${f0(d.gust)} mph`, `Wind gusts to ${f0(d.gust)} mph`);
  if (d.rain >= HEAVY_RAIN_IN) add('wx.extreme', 'rain', 'heavy rain', `Heavy rain: ${f1(d.rain)} in`);
  return { findings: out, season: s };
}

/** Season for "firsts": winter seasons run July to June ("2026-27"). */
export function seasonOf(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ── air quality ───────────────────────────────────────────────────────────
/** A day at or past "unhealthy for sensitive groups" starts an episode;
 *  consecutive bad days don't repeat it. */
export function aqEpisodeStarts(todayMax: number, yesterdayMax: number): boolean {
  return todayMax >= AQI_UNHEALTHY_SG && !(yesterdayMax >= AQI_UNHEALTHY_SG);
}
