/**
 * Small persisted UI preferences (not layer enablement — that's
 * layers/registry). Same localStorage discipline: JSON under an
 * 'orrery:' key, defaults on any parse failure.
 */

const STORAGE_KEY = 'orrery:prefs';

export interface Prefs {
  /** Globe auto-rotate. Manual pause is permanent until re-enabled. */
  spinEnabled: boolean;
}

const DEFAULTS: Prefs = { spinEnabled: true };

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private mode etc. — preference just won't persist */
  }
}

/**
 * Builder instrumentation gate (?debug=1): FPS meter, analyst spend, and any
 * future dev telemetry hide behind this so the default HUD speaks to a
 * viewer, not the author (fresh-eyes review, 2026-07-22).
 */
export const DEBUG_UI: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
})();
