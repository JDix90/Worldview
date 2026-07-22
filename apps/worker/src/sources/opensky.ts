/**
 * OpenSky adapter — the global picture (FOUNDATION §3). OAuth2 client
 * credentials, token cached and refreshed before its 30-minute expiry.
 * One global /states/all costs 4 credits; the 90s cadence in jobs.ts keeps
 * daily spend ≈ 3,840 against the registered tier's 4,000.
 */
import type { AircraftState, GlobalSnapshot } from '@orrery/shared';
import { env } from '../env.js';

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all?extended=true';

/** OpenSky integer emitter category → ADS-B "A" code used everywhere else. */
const CATEGORY_CODES: Record<number, string> = {
  2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7',
};

export interface OpenSkyPollResult {
  snapshot: GlobalSnapshot;
  /** Verbatim API response, for the raw debug store. */
  raw: unknown;
  /** From the x-rate-limit-remaining header, if present. */
  creditsRemaining: number | null;
  anonymous: boolean;
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) return cachedToken.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.openskyClientId,
      client_secret: env.openskyClientSecret,
    }),
    // A hung upstream must fail the poll, not park a worker slot (concurrency
    // is 2 — two hangs would stall the whole pipeline).
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenSky token request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

type StateVector = (string | number | boolean | null | number[])[];

export async function fetchGlobalSnapshot(): Promise<OpenSkyPollResult> {
  const hasCredentials = Boolean(env.openskyClientId && env.openskyClientSecret);
  const headers: Record<string, string> = {};
  let anonymous = true;
  if (hasCredentials) {
    try {
      headers.authorization = `Bearer ${await getToken()}`;
      anonymous = false;
    } catch (err) {
      if (!env.openskyAllowAnonymous) throw err;
      // credentials rejected but anonymous fallback permitted — poll degraded
    }
  } else if (!env.openskyAllowAnonymous) {
    throw new Error('OpenSky credentials missing and OPENSKY_ALLOW_ANONYMOUS is not set');
  }

  const res = await fetch(STATES_URL, { headers, signal: AbortSignal.timeout(45_000) });
  if (res.status === 401) {
    cachedToken = null; // token expired mid-flight; next poll re-authenticates
    throw new Error('OpenSky /states/all: 401 (token rejected)');
  }
  if (res.status === 429) {
    const retry = res.headers.get('x-rate-limit-retry-after-seconds') ?? res.headers.get('retry-after');
    throw new Error(`OpenSky /states/all: 429 rate limited (retry-after ${retry ?? '?'}s)`);
  }
  if (!res.ok) throw new Error(`OpenSky /states/all: HTTP ${res.status}`);

  const remaining = res.headers.get('x-rate-limit-remaining');
  const data = (await res.json()) as { time: number; states: StateVector[] | null };

  const aircraft: AircraftState[] = [];
  for (const s of data.states ?? []) {
    const lon = s[5];
    const lat = s[6];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    aircraft.push({
      hex: String(s[0]).toLowerCase(),
      callsign: typeof s[1] === 'string' && s[1].trim() ? s[1].trim() : undefined,
      originCountry: typeof s[2] === 'string' ? s[2] : undefined,
      lat,
      lon,
      altBaroM: typeof s[7] === 'number' ? s[7] : undefined,
      onGround: s[8] === true,
      groundSpeedMs: typeof s[9] === 'number' ? s[9] : undefined,
      trackDeg: typeof s[10] === 'number' ? s[10] : undefined,
      verticalRateMs: typeof s[11] === 'number' ? s[11] : undefined,
      altGeoM: typeof s[13] === 'number' ? s[13] : undefined,
      squawk: typeof s[14] === 'string' ? s[14] : undefined,
      category: typeof s[17] === 'number' ? CATEGORY_CODES[s[17]] : undefined,
      seenAt: typeof s[4] === 'number' ? s[4] : data.time,
      source: 'opensky',
    });
  }

  return {
    snapshot: { fetchedAt: data.time, source: 'opensky', aircraft },
    raw: data,
    creditsRemaining: remaining !== null && remaining !== '' ? Number(remaining) : null,
    anonymous,
  };
}
