import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Root .env is the single source of truth; third arg '' loads unprefixed vars.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const serverPort = env.ORRERY_SERVER_PORT || '8787';
  // Where the dev proxy forwards /ws, /api, /healthz. Defaults to the local
  // stack; point at the Pi 5 appliance's LAN IP (ORRERY_API_HOST=192.168.x.y)
  // to run the Mac browser against the Pi-hosted backend.
  const apiHost = env.ORRERY_API_HOST || '127.0.0.1';

  return {
    plugins: [react()],
    // satellite.js is imported inside a module worker; without pre-bundling,
    // mid-session dep discovery leaves the worker fetching a stale optimized
    // hash (504 Outdated Optimize Dep → opaque worker error)
    optimizeDeps: { include: ['satellite.js'] },
    worker: { format: 'es' as const },
    // Baked into the local bundle by design: single-user instrument, dev-only
    // build, token never leaves this machine. Revisit at Phase 4 (off the desk).
    define: {
      __ORRERY_TOKEN__: JSON.stringify(env.ORRERY_AUTH_TOKEN ?? ''),
      __FIRMS_KEY__: JSON.stringify(env.FIRMS_MAP_KEY ?? ''),
      __AISSTREAM_KEY__: JSON.stringify(env.AISSTREAM_KEY ?? ''),
    },
    server: {
      proxy: {
        '/ws': { target: `ws://${apiHost}:${serverPort}`, ws: true },
        '/healthz': { target: `http://${apiHost}:${serverPort}` },
        '/api': { target: `http://${apiHost}:${serverPort}` },
      },
    },
  };
});
