# ORRERY

A personal instrument: a 3D globe of live world conditions with an AI analyst watching the feeds. Not a product.

**Start here: [FOUNDATION.md](FOUNDATION.md)** — the source of truth. Then [PHASES.md](PHASES.md) for what's being built and [DECISIONS.md](DECISIONS.md) for why.

```sh
cp .env.example .env   # fill in
docker compose up -d   # postgres :5435, redis :6380
pnpm install
```

Workspace: `apps/web` (React + Vite + react-globe.gl) · `apps/server` (Fastify + WebSocket) · `apps/worker` (BullMQ: collector → baseline → detector → analyst) · `packages/shared` (Signal schema, types, config).

Flight data: [OpenSky Network](https://opensky-network.org) and [adsb.fi](https://adsb.fi).
