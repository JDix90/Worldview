import fs from 'node:fs';
import path from 'node:path';

// Worker may be started from the repo root or apps/worker; find .env either way.
for (const p of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]) {
  if (fs.existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

export const env = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  databaseUrl: process.env.DATABASE_URL ?? '',
  openskyClientId: process.env.OPENSKY_CLIENT_ID ?? '',
  openskyClientSecret: process.env.OPENSKY_CLIENT_SECRET ?? '',
  /**
   * Escape hatch while credentials are absent/broken: anonymous OpenSky access
   * (400 credits/day, 10s resolution). Never the intended steady state.
   */
  openskyAllowAnonymous: process.env.OPENSKY_ALLOW_ANONYMOUS === '1',
  adsbfiBaseUrl: process.env.ADSBFI_BASE_URL ?? 'https://opendata.adsb.fi/api',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  triageModel: process.env.ANALYST_TRIAGE_MODEL ?? 'claude-haiku-4-5-20251001',
  briefingModel: process.env.ANALYST_BRIEFING_MODEL ?? 'claude-sonnet-5',
  monthlySpendCapUsd: Number(process.env.ANALYST_MONTHLY_SPEND_CAP_USD ?? 10),
  /** Defaults retuned 2026-07-22 (DECISIONS #109): live spend was tracking
   *  ~$16/mo vs the §8 target of $2–4. Searches 10→4 and a 10/day S2 triage
   *  budget bring the projection back inside the target.
   *  Retuned again 2026-07-24 (comprehensive review, owner target ~$5–6/mo):
   *  the S2 triage budget drops 10→5. Pairs with holding immature D1 collapses
   *  to S3 (d1Collapse.ts) so the 5 triage slots spend on genuine S2 (GPS /
   *  clustered squawks), not diurnal noise. NOTE: the appliance .env currently
   *  overrides ANALYST_WEB_SEARCHES_PER_DAY=10 — drop that toward 4 to land the
   *  target; the $10 breaker + 70% alert remain the backstop. */
  webSearchesPerDay: Number(process.env.ANALYST_WEB_SEARCHES_PER_DAY ?? 4),
  triagePerDay: Number(process.env.ANALYST_TRIAGE_PER_DAY ?? 5),
  /** Flight signals are triaged only within this many miles of home; 0 means
   *  anywhere. The owner kept only Denver-area flight checks (DECISIONS #144):
   *  100 mi covers the Front Range, DEN and the I-70 corridor to Vail. */
  triageRadiusMi: Number(process.env.ANALYST_TRIAGE_RADIUS_MI ?? 100),
  /** Precise home point for the home briefing (FOUNDATION §12, DECISIONS #144).
   *  Set only in the appliance's .env; never committed. Unset → the server's
   *  `settings:home` anchor, which is rounded to 0.01°. */
  homeLat: process.env.HOME_LAT ? Number(process.env.HOME_LAT) : NaN,
  homeLon: process.env.HOME_LON ? Number(process.env.HOME_LON) : NaN,
  /** Local hour the home note (and Monday roundup) files; 25 disables it, as
   *  BRIEFING_HOUR_LOCAL=25 does for the flights briefing. */
  homeNoteHourLocal: Number(process.env.HOME_NOTE_HOUR_LOCAL ?? 7),
  /** FOUNDATION §8/§12: small model for the note, larger for the roundup,
   *  current generation (the triage/briefing pins above predate them). */
  homeNoteModel: process.env.HOME_NOTE_MODEL ?? 'claude-haiku-5-5',
  homeRoundupModel: process.env.HOME_ROUNDUP_MODEL ?? 'claude-sonnet-5-5',
  /** Home notes go to the phone by default (owner, DECISIONS #144): ntfy
   *  priority 3, so the phone's own sound/silent settings decide. */
  homePushEnabled: process.env.HOME_PUSH_ENABLED !== 'false',
  /** Last-resort home, matching the server's default (Denver). */
  ownerLat: Number(process.env.OWNER_LAT ?? 39.74),
  ownerLon: Number(process.env.OWNER_LON ?? -104.99),
  briefingHourLocal: Number(process.env.BRIEFING_HOUR_LOCAL ?? 7),
  briefingTimezone: process.env.BRIEFING_TIMEZONE ?? 'America/Denver',
  /** Anomaly push. Ships false — the FOUNDATION §4 calibration gate. */
  pushEnabled: process.env.PUSH_ENABLED === 'true',
  /** Infrastructure alerts (collector down). Separate, owner-opt-in. */
  opsAlertsEnabled: process.env.OPS_ALERTS_ENABLED === 'true',
  ntfyTopic: process.env.NTFY_TOPIC ?? '',
  rawDataDir:
    process.env.RAW_DATA_DIR ??
    (fs.existsSync(path.resolve(process.cwd(), 'pnpm-workspace.yaml'))
      ? path.resolve(process.cwd(), 'data/raw')
      : path.resolve(process.cwd(), '../../data/raw')),
};
