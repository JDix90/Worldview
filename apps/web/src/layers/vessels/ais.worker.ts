/**
 * aisstream.io ingest worker — the global AIS firehose (~300 msg/s on a
 * full-world subscription) stays off the main thread. Owns the WebSocket,
 * keeps per-MMSI latest state, and posts a compact typed-array snapshot at
 * 1Hz. Envelope shapes from aisstream.io/documentation (2026-07-17):
 *   { MessageType, MetaData: { MMSI, ShipName }, Message: { <Type>: {...} } }
 * PositionReport: UserID, Latitude, Longitude, Sog (kt), Cog, TrueHeading.
 * ShipStaticData: Name, Type (AIS code), Destination.
 * The parser is tolerant (MetaData/Metadata casing, missing fields) and
 * counts unknown shapes so first live contact surfaces mismatches loudly.
 * Subscription MUST be sent within 3s of connect (service requirement).
 */

interface VesselState {
  lat: number;
  lon: number;
  sogKt: number;
  cogDeg: number;
  name: string | null;
  type: number; // AIS ship-type code, 0 = unknown
  destination: string | null;
  seenAt: number; // ms epoch
}

interface StartMsg {
  kind: 'start';
  apiKey: string;
}

const WS_URL = 'wss://stream.aisstream.io/v0/stream';
const SNAPSHOT_MS = 1000;
const PURGE_MS = 30 * 60_000;
const STATS_MS = 10_000;
const MAX_VESSELS = 60_000;

const vessels = new Map<number, VesselState>();
let ws: WebSocket | null = null;
let apiKey = '';
let backoffMs = 1000;
let msgCount = 0;
let unknownCount = 0;
let unknownSampleSent = false;

function connect(): void {
  ws = new WebSocket(WS_URL);
  // aisstream delivers JSON as *binary* frames; the browser surfaces those as
  // Blob by default (async to read), so JSON.parse(ev.data) throws on every
  // message. Force ArrayBuffer and decode synchronously below. (Node's `ws`
  // gave decodable Buffers, which hid this in every server-side test.)
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    backoffMs = 1000;
    // must arrive within 3s of connect
    ws!.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }),
    );
  };
  ws.onmessage = (ev) => {
    msgCount++;
    const text =
      typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    try {
      const env = JSON.parse(text) as {
        MessageType?: string;
        MetaData?: { MMSI?: number; ShipName?: string };
        Metadata?: { MMSI?: number; ShipName?: string };
        Message?: Record<string, Record<string, unknown>>;
      };
      const meta = env.MetaData ?? env.Metadata;
      const body = env.Message?.[env.MessageType ?? ''] ?? env.Message;
      if (!env.MessageType || !body) {
        unknownCount++;
        if (!unknownSampleSent) {
          unknownSampleSent = true;
          postMessage({ kind: 'diagnostic', sample: text.slice(0, 400) });
        }
        return;
      }
      if (env.MessageType === 'PositionReport') {
        const m = body as { UserID?: number; Latitude?: number; Longitude?: number; Sog?: number; Cog?: number };
        const mmsi = m.UserID ?? meta?.MMSI;
        if (typeof mmsi !== 'number' || typeof m.Latitude !== 'number' || typeof m.Longitude !== 'number') {
          unknownCount++;
          return;
        }
        const v = vessels.get(mmsi);
        const name = meta?.ShipName?.trim() || v?.name || null;
        vessels.set(mmsi, {
          lat: m.Latitude,
          lon: m.Longitude,
          sogKt: typeof m.Sog === 'number' ? m.Sog : v?.sogKt ?? 0,
          cogDeg: typeof m.Cog === 'number' ? m.Cog : v?.cogDeg ?? 0,
          name,
          type: v?.type ?? 0,
          destination: v?.destination ?? null,
          seenAt: Date.now(),
        });
      } else if (env.MessageType === 'ShipStaticData') {
        const m = body as { Name?: string; Type?: number; Destination?: string };
        const mmsi = meta?.MMSI;
        if (typeof mmsi !== 'number') return;
        const v = vessels.get(mmsi);
        if (v) {
          v.name = m.Name?.trim() || v.name;
          v.type = typeof m.Type === 'number' ? m.Type : v.type;
          v.destination = m.Destination?.trim() || v.destination;
        } else if (vessels.size < MAX_VESSELS) {
          // static data before first position: hold metadata, no position yet
          vessels.set(mmsi, {
            lat: NaN,
            lon: NaN,
            sogKt: 0,
            cogDeg: 0,
            name: m.Name?.trim() || null,
            type: m.Type ?? 0,
            destination: m.Destination?.trim() || null,
            seenAt: Date.now(),
          });
        }
      }
    } catch {
      unknownCount++;
    }
  };
  ws.onclose = () => {
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  };
  ws.onerror = () => ws?.close();
}

function snapshot(): void {
  const now = Date.now();
  // purge stale + positionless leftovers
  for (const [mmsi, v] of vessels) {
    if (now - v.seenAt > PURGE_MS) vessels.delete(mmsi);
  }
  const withPos: Array<[number, VesselState]> = [];
  for (const e of vessels) {
    if (Number.isFinite(e[1].lat)) withPos.push(e);
  }
  const n = withPos.length;
  const f = new Float32Array(n * 4); // lat, lon, sogKt, cogDeg
  const mmsis = new Float64Array(n); // MMSI can exceed 2^24; f64 is exact
  const types = new Uint8Array(n); // bucketed below deck: raw code % 256
  for (let i = 0; i < n; i++) {
    const [mmsi, v] = withPos[i]!;
    f[i * 4] = v.lat;
    f[i * 4 + 1] = v.lon;
    f[i * 4 + 2] = v.sogKt;
    f[i * 4 + 3] = v.cogDeg;
    mmsis[i] = mmsi;
    types[i] = v.type & 0xff;
  }
  postMessage({ kind: 'snapshot', n, f, mmsis, types, tracked: vessels.size }, {
    transfer: [f.buffer, mmsis.buffer, types.buffer],
  });
}

function stats(): void {
  postMessage({ kind: 'stats', msgPerSec: +(msgCount / (STATS_MS / 1000)).toFixed(1), unknownCount, tracked: vessels.size });
  msgCount = 0;
}

/** Card detail lookup: main thread asks for one vessel's full state. */
interface DetailMsg {
  kind: 'detail';
  mmsi: number;
}

onmessage = (ev: MessageEvent<StartMsg | DetailMsg>) => {
  const msg = ev.data;
  if (msg.kind === 'start') {
    apiKey = msg.apiKey;
    connect();
    setInterval(snapshot, SNAPSHOT_MS);
    setInterval(stats, STATS_MS);
  } else if (msg.kind === 'detail') {
    const v = vessels.get(msg.mmsi);
    postMessage({ kind: 'detail', mmsi: msg.mmsi, vessel: v ?? null });
  }
};
