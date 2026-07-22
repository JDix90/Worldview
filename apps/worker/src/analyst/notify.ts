/**
 * ntfy.sh delivery. Two independent gates:
 *  - anomaly push: PUSH_ENABLED — ships FALSE (FOUNDATION §4 calibration
 *    gate); until the owner reviews the shadow log and flips it, S1s only log.
 *  - ops alerts (collector down): OPS_ALERTS_ENABLED — infrastructure health,
 *    not anomaly judgment, so it is opt-in separately from the gate.
 * The topic name is the credential; it never appears in logs.
 */
import { env } from '../env.js';
import { log, logError } from '../log.js';

/**
 * HTTP header values are ByteStrings (Latin-1). Every title here reads
 * "ORRERY — …", and that em dash (U+2014) made `fetch` throw before the
 * request was ever sent — so *every* ops alert failed silently, including the
 * collector-silent alarm that fired during the 2026-07-22 OpenSky outage and
 * never reached anyone (DECISIONS #117). The body is unaffected: only headers
 * are constrained, so the punctuation is transliterated rather than dropped.
 */
function headerSafe(s: string): string {
  return s
    .replace(/[—–]/g, '-')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/…/g, '...')
    .replace(/[^\x20-\xFF]/g, '?'); // anything still outside Latin-1
}

async function send(title: string, message: string, priority: 3 | 4): Promise<boolean> {
  if (!env.ntfyTopic) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${env.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: headerSafe(title), Priority: String(priority) },
      body: message,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
    return true;
  } catch (err) {
    logError('notify', 'ntfy send failed', err);
    return false;
  }
}

/** Returns whether a push actually went out (false in shadow mode). */
export async function pushAnomaly(title: string, message: string): Promise<boolean> {
  if (!env.pushEnabled) {
    log('notify', 'shadow mode — push suppressed', { title });
    return false;
  }
  return send(title, message, 4);
}

export async function pushOps(title: string, message: string): Promise<boolean> {
  if (!env.opsAlertsEnabled) return false;
  return send(title, message, 3);
}
