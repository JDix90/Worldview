/**
 * 48h raw-response store (DECISIONS #14): one gzipped JSON file per poll under
 * data/raw/<source>/. Debugging material only — replayable by the chunk 5
 * detector harness, TTL-deleted, and the whole mechanism is removable after
 * the Go/No-Go if never used. Per-snapshot files (not appended logs) so a
 * crash can never corrupt more than the file being written.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { env } from './env.js';

const gzip = promisify(zlib.gzip);

export const RAW_TTL_MS = 48 * 3600 * 1000;

export async function writeRaw(source: string, kind: string, payload: unknown): Promise<string> {
  const dir = path.join(env.rawDataDir, source);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${kind}.json.gz`);
  await fs.promises.writeFile(file, await gzip(Buffer.from(JSON.stringify(payload))));
  return file;
}

/** Delete raw files older than the TTL. Returns how many were removed. */
export async function cleanRaw(maxAgeMs: number = RAW_TTL_MS): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  let sources: string[];
  try {
    sources = await fs.promises.readdir(env.rawDataDir);
  } catch {
    return 0; // nothing written yet
  }
  for (const source of sources) {
    const dir = path.join(env.rawDataDir, source);
    const stat = await fs.promises.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    for (const name of await fs.promises.readdir(dir)) {
      const file = path.join(dir, name);
      const fstat = await fs.promises.stat(file).catch(() => null);
      if (fstat?.isFile() && fstat.mtimeMs < cutoff) {
        await fs.promises.unlink(file).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}
