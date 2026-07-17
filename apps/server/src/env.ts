import fs from 'node:fs';
import path from 'node:path';

// Server may be started from the repo root or apps/server; find .env either way.
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
  port: Number(process.env.ORRERY_SERVER_PORT ?? 8787),
  /** 127.0.0.1 on the host; 0.0.0.0 inside the container (compose maps it back to loopback). */
  host: process.env.ORRERY_SERVER_HOST ?? '127.0.0.1',
  /** Single-user static bearer token (FOUNDATION §5 assumptions). Required. */
  authToken: process.env.ORRERY_AUTH_TOKEN ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Directory of a built web client to serve statically (appliance mode). */
  webDist: process.env.ORRERY_WEB_DIST ?? '',
};
