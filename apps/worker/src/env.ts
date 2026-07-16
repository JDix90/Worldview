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
  webSearchesPerDay: Number(process.env.ANALYST_WEB_SEARCHES_PER_DAY ?? 10),
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
