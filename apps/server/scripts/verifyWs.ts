/**
 * Live WebSocket integration check against a running server + collector.
 * Run: pnpm --filter @orrery/server verify:ws
 * Verifies: bad token rejected (1008); good token gets a snapshot; a delta
 * or heartbeat arrives on schedule. Uses Node 22's built-in WebSocket.
 */
import { env } from '../src/env.js';

const BASE = `ws://127.0.0.1:${env.port}/ws`;
let failures = 0;
function report(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function closeCode(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); resolve(-1); }, timeoutMs);
    ws.addEventListener('close', (ev) => { clearTimeout(t); resolve(ev.code); });
  });
}

// 1. wrong token → policy-violation close
report('bad token rejected with 1008', (await closeCode(`${BASE}?token=wrong`, 3000)) === 1008);

// 2. good token → snapshot, then a delta (≤100s at the 90s cadence) or at
//    least a meta heartbeat (30s) proving the stream stays alive
const result = await new Promise<{ snapshotCount: number; followUp: string | null }>((resolve) => {
  const ws = new WebSocket(`${BASE}?token=${encodeURIComponent(env.authToken)}`);
  let snapshotCount = -1;
  const t = setTimeout(() => { ws.close(); resolve({ snapshotCount, followUp: null }); }, 100_000);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'snapshot') {
      snapshotCount = msg.aircraft.length;
    } else if (snapshotCount >= 0) {
      clearTimeout(t);
      ws.close();
      resolve({ snapshotCount, followUp: msg.type });
    }
  });
  ws.addEventListener('error', () => { clearTimeout(t); resolve({ snapshotCount, followUp: null }); });
});

report('snapshot received on connect', result.snapshotCount >= 0, `${result.snapshotCount} aircraft`);
report('live global picture present (>5000 aircraft)', result.snapshotCount > 5000, `${result.snapshotCount}`);
report('stream stays alive (delta or heartbeat)', result.followUp !== null, `got ${result.followUp}`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll WebSocket checks passed.');
