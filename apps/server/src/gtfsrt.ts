/**
 * Minimal GTFS-Realtime VehiclePosition decoder (round 1 W3, #125).
 * Hand-rolled protobuf reader for exactly the fields the CITY map's transit
 * layer renders — `gtfs-realtime-bindings` (+protobufjs) was rejected to
 * keep the server dependency-free, consistent with the project's taste
 * (cf. the hand-rolled OSM mosaic and CAP parse).
 *
 * Wire format refresher: each field = key varint (fieldNo << 3 | wireType);
 * wiretype 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit.
 * FeedMessage{ 2: repeated FeedEntity{ 3: VehiclePosition{ 1: TripDescriptor
 * { 1: trip_id, 5: route_id }, 2: Position{ 1: lat f32, 2: lon f32,
 * 3: bearing f32 }, 5: timestamp, 8: VehicleDescriptor{ 1: id, 2: label } } } }
 */

export interface TransitVehicle {
  id: string;
  label: string | null;
  routeId: string | null;
  lat: number;
  lon: number;
  bearingDeg: number | null;
  tsSec: number | null;
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0, shift = 0;
    for (;;) {
      const b = this.buf[this.pos++]!;
      result += shift < 28 ? (b & 0x7f) << shift : (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  f32(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) {
      // NOT `this.pos += this.varint()`: JS evaluates the left operand of +=
      // BEFORE the call, and varint() itself advances pos while reading the
      // length bytes — the compound form lands short by the width of the
      // length varint. Cost a real debugging session; leave it two lines.
      const len = this.varint();
      this.pos += len;
    } else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

const utf8 = new TextDecoder();

function decodePosition(buf: Uint8Array): { lat?: number; lon?: number; bearing?: number } {
  const r = new Reader(buf);
  const out: { lat?: number; lon?: number; bearing?: number } = {};
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3, wt = key & 7;
    if (field === 1 && wt === 5) out.lat = r.f32();
    else if (field === 2 && wt === 5) out.lon = r.f32();
    else if (field === 3 && wt === 5) out.bearing = r.f32();
    else r.skip(wt);
  }
  return out;
}

function decodeTrip(buf: Uint8Array): { routeId?: string } {
  const r = new Reader(buf);
  const out: { routeId?: string } = {};
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3, wt = key & 7;
    if (field === 5 && wt === 2) out.routeId = utf8.decode(r.bytes());
    else r.skip(wt);
  }
  return out;
}

function decodeVehicleDesc(buf: Uint8Array): { id?: string; label?: string } {
  const r = new Reader(buf);
  const out: { id?: string; label?: string } = {};
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3, wt = key & 7;
    if (field === 1 && wt === 2) out.id = utf8.decode(r.bytes());
    else if (field === 2 && wt === 2) out.label = utf8.decode(r.bytes());
    else r.skip(wt);
  }
  return out;
}

function decodeVehiclePosition(buf: Uint8Array): TransitVehicle | null {
  const r = new Reader(buf);
  let pos: { lat?: number; lon?: number; bearing?: number } = {};
  let trip: { routeId?: string } = {};
  let desc: { id?: string; label?: string } = {};
  let ts: number | null = null;
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3, wt = key & 7;
    if (field === 1 && wt === 2) trip = decodeTrip(r.bytes());
    else if (field === 2 && wt === 2) pos = decodePosition(r.bytes());
    else if (field === 5 && wt === 0) ts = r.varint();
    else if (field === 8 && wt === 2) desc = decodeVehicleDesc(r.bytes());
    else r.skip(wt);
  }
  if (pos.lat === undefined || pos.lon === undefined) return null;
  return {
    id: desc.id ?? '?',
    label: desc.label ?? null,
    routeId: trip.routeId ?? null,
    lat: pos.lat,
    lon: pos.lon,
    bearingDeg: pos.bearing ?? null,
    tsSec: ts,
  };
}

export function decodeVehicleFeed(buf: Uint8Array): TransitVehicle[] {
  const r = new Reader(buf);
  const out: TransitVehicle[] = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3, wt = key & 7;
    if (field === 2 && wt === 2) {
      // FeedEntity
      const er = new Reader(r.bytes());
      while (!er.done) {
        const ek = er.varint();
        const ef = ek >> 3, ewt = ek & 7;
        // FeedEntity: id=1, is_deleted=2, trip_update=3, VEHICLE=4, alert=5
        if (ef === 4 && ewt === 2) {
          const v = decodeVehiclePosition(er.bytes());
          if (v) out.push(v);
        } else er.skip(ewt);
      }
    } else r.skip(wt);
  }
  return out;
}
