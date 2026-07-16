/**
 * WebSocket client: connects same-origin (`/ws`, proxied by Vite to the
 * server), applies frames to the store, reconnects with capped exponential
 * backoff, and watchdogs the connection — the server heartbeats every 30s,
 * so 75s of silence means the socket is dead even if it looks open.
 */
import { useEffect, useRef, useState } from 'react';
import type { WsServerMsg } from '@orrery/shared';
import type { AircraftStore } from './aircraftStore';

export type FeedStatus = 'connecting' | 'live' | 'reconnecting';

const WATCHDOG_MS = 75_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function useAircraftFeed(store: AircraftStore): { status: FeedStatus } {
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let backoffMs = BACKOFF_START_MS;
    let lastMessageAt = Date.now();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const watchdog = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > WATCHDOG_MS) {
        ws.close(); // triggers the reconnect path
      }
    }, 15_000);

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(__ORRERY_TOKEN__)}`);

      ws.addEventListener('open', () => {
        lastMessageAt = Date.now();
      });
      ws.addEventListener('message', (ev) => {
        lastMessageAt = Date.now();
        const msg = JSON.parse(String(ev.data)) as WsServerMsg;
        if (msg.type === 'snapshot') {
          storeRef.current.applySnapshot(msg);
          backoffMs = BACKOFF_START_MS; // healthy session established
          setStatus('live');
        } else if (msg.type === 'delta') {
          storeRef.current.applyDelta(msg);
        }
        // meta frames only refresh lastMessageAt (watchdog food)
      });
      ws.addEventListener('close', () => {
        if (disposed) return;
        setStatus('reconnecting');
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      });
      ws.addEventListener('error', () => ws?.close());
    };

    connect();
    return () => {
      disposed = true;
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { status };
}
