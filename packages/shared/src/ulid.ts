/**
 * Minimal ULID (Crockford base32, 48-bit time + 80-bit randomness). Sortable
 * by emission time, which is all the Signal pipeline needs — not strictly
 * monotonic within a millisecond, and the modulo bias is irrelevant for ids.
 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs = Date.now()): string {
  let ts = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  globalThis.crypto.getRandomValues(rand);
  let r = '';
  for (let i = 0; i < 16; i++) r += B32[rand[i]! % 32];
  return ts + r;
}
