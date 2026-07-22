/**
 * Find-a-flight (Phase 1 A2, DECISIONS #120): press `/`, type a callsign or
 * hex, Enter — the globe flies there and the aircraft card opens. Pure
 * client: both stores are already in memory, so search costs nothing and
 * works exactly as far as the live picture does. The empty state names the
 * corpus searched — "no results" that doesn't say what was searched is how
 * instruments get distrusted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AircraftStore } from '../feed/aircraftStore';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const DIM = 'rgba(143,163,184,0.85)';

interface Hit {
  hex: string;
  callsign: string;
  altFt: number | null;
  mil: boolean;
  lat: number;
  lon: number;
}

interface Props {
  store: AircraftStore;
  milStore: AircraftStore;
  /** Select an aircraft in the app (opens the card). Civil hexes only. */
  onSelect: (hex: string) => void;
}

function searchStores(store: AircraftStore, milStore: AircraftStore, q: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const out: Hit[] = [];
  const scan = (s: AircraftStore, mil: boolean) => {
    for (const [hex, t] of s.byHex) {
      if (t.state.onGround) continue;
      const cs = (t.state.callsign ?? '').trim().toLowerCase();
      if (!cs.startsWith(needle) && !hex.startsWith(needle)) continue;
      out.push({
        hex,
        callsign: t.state.callsign?.trim() || '—',
        altFt: t.state.altBaroM != null ? Math.round(t.state.altBaroM * 3.28084) : null,
        mil,
        lat: t.renderLat,
        lon: t.renderLon,
      });
      if (out.length >= 30) return;
    }
  };
  scan(store, false);
  scan(milStore, true);
  // exact callsign matches first, then alphabetical — deterministic, no scoring
  out.sort((a, b) => {
    const ax = a.callsign.toLowerCase() === needle ? 0 : 1;
    const bx = b.callsign.toLowerCase() === needle ? 0 : 1;
    return ax - bx || a.callsign.localeCompare(b.callsign);
  });
  return out.slice(0, 5);
}

export function FlightSearch({ store, milStore, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === '/' && !open && !typing) {
        e.preventDefault();
        setQ('');
        setIdx(0);
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const hits = useMemo(() => (open ? searchStores(store, milStore, q) : []), [open, q, store, milStore]);
  const corpus = open ? store.stats().rendered + milStore.stats().rendered : 0;

  if (!open) return null;

  const go = (h: Hit) => {
    const g = (window as { __ORRERY__?: { globe?: { pointOfView(p: object, ms: number): void } } })
      .__ORRERY__?.globe;
    if (g) g.pointOfView({ lat: h.lat, lng: h.lon, altitude: 0.5 }, 900);
    // Mil aircraft live in their own layer/store; the civil card can't
    // resolve them, so a mil hit is fly-to only — honest, not broken.
    if (!h.mil) onSelect(h.hex);
    setOpen(false);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 84,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 320,
        zIndex: 45,
        font: `12px/1.6 ${mono}`,
        background: 'rgba(6,10,16,0.96)',
        border: '1px solid rgba(79,216,255,0.35)',
        borderRadius: 4,
        padding: '8px 10px',
        boxShadow: '0 6px 30px rgba(0,0,0,0.6)',
        color: 'rgba(200,214,229,0.92)',
      }}
    >
      <input
        ref={inputRef}
        value={q}
        placeholder="callsign or hex…"
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0));
          else if ((e.key === 'Enter' || e.key === 'Return') && hits[idx]) go(hits[idx]);
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          font: `13px ${mono}`,
          color: '#e6eef6',
          background: 'rgba(20,32,44,0.9)',
          border: '1px solid rgba(79,216,255,0.35)',
          borderRadius: 3,
          padding: '5px 8px',
          outline: 'none',
        }}
      />
      {q.trim().length >= 2 && hits.length === 0 && (
        <div style={{ opacity: 0.55, marginTop: 6 }}>
          not among {corpus.toLocaleString()} aircraft currently tracked
        </div>
      )}
      {hits.map((h, i) => (
        <div
          key={h.hex}
          onClick={() => go(h)}
          onMouseEnter={() => setIdx(i)}
          style={{
            display: 'flex',
            gap: 8,
            padding: '3px 6px',
            marginTop: i === 0 ? 6 : 0,
            cursor: 'pointer',
            borderRadius: 3,
            background: i === idx ? 'rgba(79,216,255,0.12)' : 'transparent',
          }}
        >
          <span style={{ color: h.mil ? AMBER : CYAN, minWidth: 78 }}>{h.callsign}</span>
          <span style={{ opacity: 0.5 }}>{h.hex}</span>
          <span style={{ flex: 1 }} />
          <span style={{ opacity: 0.65 }}>{h.altFt != null ? `${h.altFt.toLocaleString()} ft` : ''}</span>
          {h.mil && <span style={{ color: AMBER, fontSize: 10 }}>MIL</span>}
        </div>
      ))}
      <div style={{ opacity: 0.35, fontSize: 10, marginTop: 6 }}>
        ↑↓ choose · enter fly · esc close
      </div>
    </div>
  );
}
