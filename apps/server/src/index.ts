/**
 * ORRERY API server — one authenticated WebSocket feeding the client
 * (FOUNDATION §2, §5). Binds 127.0.0.1 only: single-user, no public exposure.
 *
 * Auth: static bearer token. HTTP via Authorization header; the WebSocket via
 * `?token=` query param (accepted trade-off for a localhost instrument — the
 * URL never leaves this machine and request logging is off; revisit in Phase 4).
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import pg from 'pg';
import { WS_CLOSE_UNAUTHORIZED, type WsMetaMsg } from '@orrery/shared';
import { env } from './env.js';
import { SnapshotFeed } from './snapshotFeed.js';
import { registerApi } from './api.js';
import { log, logError } from './log.js';

const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  if (!env.authToken) {
    throw new Error('ORRERY_AUTH_TOKEN is not set — refusing to start without auth');
  }

  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 2 });
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 3 });
  const feed = new SnapshotFeed(redis);
  await feed.start();

  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerApi(app, pool, feed, redis);

  // Liveness + snapshot staleness; unauthenticated by design (leaks only an age).
  app.get('/healthz', async () => {
    const fetchedAt = feed.snapshotFetchedAt();
    return {
      ok: true,
      snapshotAgeS: fetchedAt ? Math.round(Date.now() / 1000 - fetchedAt) : null,
    };
  });

  const clients = new Set<WebSocket>();

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, req) => {
      const token = (req.query as Record<string, string | undefined>).token;
      if (token !== env.authToken) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      clients.add(socket);
      log('ws', 'client connected', { clients: clients.size });
      socket.send(JSON.stringify(feed.snapshotMsg()));
      socket.send(JSON.stringify(feed.milMsg()));
      socket.on('close', () => {
        clients.delete(socket);
        log('ws', 'client disconnected', { clients: clients.size });
      });
      socket.on('error', (err: Error) => logError('ws', 'socket error', err));
    });
  });

  feed.onDelta((msg) => {
    if (clients.size === 0) return;
    const frame = JSON.stringify(msg);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  });

  // Heartbeat: JSON meta for the client's staleness display and watchdog,
  // plus a protocol-level ping so half-dead sockets get reaped.
  const heartbeat = setInterval(() => {
    const fetchedAt = feed.snapshotFetchedAt();
    const msg: WsMetaMsg = {
      type: 'meta',
      snapshotFetchedAt: fetchedAt,
      snapshotAgeS: fetchedAt ? Math.round(Date.now() / 1000 - fetchedAt) : -1,
      serverTimeMs: Date.now(),
    };
    const frame = JSON.stringify(msg);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(frame);
        socket.ping();
      }
    }
  }, HEARTBEAT_MS);

  await app.listen({ port: env.port, host: env.host });
  log('server', 'listening', { host: env.host, port: env.port, redis: env.redisUrl });

  const shutdown = async (signal: string) => {
    log('server', `${signal} — shutting down`);
    clearInterval(heartbeat);
    feed.stop();
    await app.close();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logError('server', 'fatal on startup', err);
  process.exit(1);
});
