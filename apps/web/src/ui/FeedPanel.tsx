/**
 * The feed panel (FOUNDATION §4): S2 badges, S3 dim, S1 loud; assessments
 * inline; briefing tab. Collapsed by default — the globe is the instrument,
 * this is its margin notes. Polls the API at 60s.
 */
import { useEffect, useState } from 'react';
import type { Severity, Signal } from '@orrery/shared';
import { apiGet } from '../feed/api';
import { DEBUG_UI } from '../prefs';

interface FeedSignal extends Signal {
  assessment: {
    disposition: string;
    severity_final: Severity;
    narrative: string;
    sources_consulted: string[];
    confidence: number;
  } | null;
}
interface Briefing {
  date_local: string;
  ts: string;
  body_md: string;
  quiet: boolean;
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SEV_COLOR: Record<Severity, string> = {
  S1: '#ff5c5c',
  S2: '#ffb300',
  S3: 'rgba(143,163,184,0.55)',
};

const panel: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 340,
  padding: '12px 14px',
  overflowY: 'auto',
  font: `11px/1.55 ${mono}`,
  color: 'rgba(200,214,229,0.92)',
  background: 'rgba(6,10,16,0.88)',
  borderLeft: '1px solid rgba(79,216,255,0.18)',
  backdropFilter: 'blur(4px)',
};

/** 24h world-traffic sparkline — the instrument's heartbeat. */
function Sparkline({ points }: { points: Array<{ ts: number; total: number }> }) {
  if (points.length < 2) return null;
  const W = 310, H = 44;
  const totals = points.map((p) => p.total);
  const min = Math.min(...totals), max = Math.max(...totals);
  const span = Math.max(1, max - min);
  const t0 = points[0]!.ts, t1 = points[points.length - 1]!.ts;
  const tspan = Math.max(1, t1 - t0);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(((p.ts - t0) / tspan) * W).toFixed(1)},${(H - 6 - ((p.total - min) / span) * (H - 12)).toFixed(1)}`)
    .join(' ');
  const cur = totals[totals.length - 1]!;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', opacity: 0.55, marginBottom: 2 }}>
        <span style={{ color: '#4fd8ff', letterSpacing: 1 }}>WORLD TRAFFIC · 24H</span>
        <span style={{ flex: 1 }} />
        <span>{cur.toLocaleString()} now</span>
      </div>
      <svg width={W} height={H} style={{ display: 'block' }}>
        <path d={path} fill="none" stroke="#4fd8ff" strokeWidth="1.2" opacity="0.85" />
        <circle cx={W} cy={H - 6 - ((cur - min) / span) * (H - 12)} r="2.4" fill="#4fd8ff" />
      </svg>
      <div style={{ display: 'flex', opacity: 0.4, fontSize: 9 }}>
        <span>low {min.toLocaleString()}</span>
        <span style={{ flex: 1 }} />
        <span>high {max.toLocaleString()}</span>
      </div>
    </div>
  );
}

/** Renders briefing markdown just enough for the feed: `**bold**` becomes
 *  bold, `#`-headers become cyan section lines — raw asterisks read as a
 *  rendering bug to a first-time viewer (fresh-eyes review, 2026-07-22). */
function MarkdownLite({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const header = line.match(/^#{1,3}\s+(.*)$/);
        const content = header ? header[1]! : line;
        const parts = content
          .split(/\*\*(.+?)\*\*/g)
          .map((seg, j) => (j % 2 === 1 ? <strong key={j} style={{ color: '#dbe7f3' }}>{seg}</strong> : seg));
        if (header) {
          return (
            <div key={i} style={{ color: '#4fd8ff', letterSpacing: 1, margin: '6px 0 2px' }}>
              {parts}
            </div>
          );
        }
        return <div key={i}>{content === '' ? ' ' : parts}</div>;
      })}
    </>
  );
}

interface FeedPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedPanel({ open, onOpenChange }: FeedPanelProps) {
  const [tab, setTab] = useState<'signals' | 'briefing'>('signals');
  const [signals, setSignals] = useState<FeedSignal[]>([]);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [cost, setCost] = useState<{ mtd_usd: number } | null>(null);
  const [traffic, setTraffic] = useState<Array<{ ts: number; total: number }>>([]);
  const [learning, setLearning] = useState<{ totalBins: number; mature: number; partial: number; warmup: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      apiGet<{ signals: FeedSignal[] }>('/api/signals?limit=50')
        .then((d) => alive && setSignals(d.signals))
        .catch(() => undefined);
      apiGet<{ briefings: Briefing[] }>('/api/briefings?limit=1')
        .then((d) => alive && setBriefing(d.briefings[0] ?? null))
        .catch(() => undefined);
      if (DEBUG_UI) {
        apiGet<{ monthToDate: { mtd_usd: number } }>('/api/analyst/usage')
          .then((d) => alive && setCost(d.monthToDate))
          .catch(() => undefined);
      }
    };
    const loadStats = () => {
      apiGet<{ points: Array<{ ts: number; total: number }> }>('/api/stats/traffic24h')
        .then((d) => alive && setTraffic(d.points))
        .catch(() => undefined);
      apiGet<{ totalBins: number; mature: number; partial: number; warmup: number }>('/api/stats/learning')
        .then((d) => alive && setLearning(d))
        .catch(() => undefined);
    };
    load();
    loadStats();
    const id = setInterval(load, 60_000);
    const sid = setInterval(loadStats, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(sid);
    };
  }, []);

  const flyTo = (lat: number, lng: number) => {
    const g = (window as { __ORRERY__?: { globe?: { pointOfView(p: object, ms: number): void } } }).__ORRERY__?.globe;
    if (g) g.pointOfView({ lat, lng, altitude: 0.8 }, 900);
  };

  const dayAgo = Date.now() - 86_400_000;
  const badge = signals.filter(
    (s) => (s.severity === 'S2' || s.severity === 'S1') && new Date(s.ts).getTime() > dayAgo,
  ).length;

  if (!open) {
    return (
      <div
        onClick={() => onOpenChange(true)}
        style={{
          position: 'fixed', top: 10, right: 12, cursor: 'pointer',
          font: `11px ${mono}`, color: 'rgba(143,163,184,0.85)',
          padding: '4px 10px', border: '1px solid rgba(79,216,255,0.25)',
          borderRadius: 3, background: 'rgba(6,10,16,0.7)', userSelect: 'none',
        }}
      >
        FEED{badge > 0 && <span style={{ color: SEV_COLOR.S2 }}> ●{badge}</span>}
      </div>
    );
  }

  return (
    <div style={panel}>
      <div style={{ display: 'flex', gap: 14, marginBottom: 10, alignItems: 'baseline' }}>
        {(['signals', 'briefing'] as const).map((t) => (
          <span
            key={t}
            onClick={() => setTab(t)}
            style={{
              cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1,
              color: tab === t ? '#4fd8ff' : 'rgba(143,163,184,0.6)',
              borderBottom: tab === t ? '1px solid #4fd8ff' : 'none',
            }}
          >
            {t}
            {t === 'signals' && badge > 0 && <span style={{ color: SEV_COLOR.S2 }}> ●{badge}</span>}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        {DEBUG_UI && cost && <span style={{ opacity: 0.45 }}>${cost.mtd_usd.toFixed(2)} mtd</span>}
        <span onClick={() => onOpenChange(false)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
      </div>

      {tab === 'signals' && (
        <div>
          <Sparkline points={traffic} />
          <div style={{ opacity: 0.45, marginBottom: 8, fontSize: 10 }}>
            <span style={{ color: SEV_COLOR.S1 }}>S1</span> page-worthy ·{' '}
            <span style={{ color: SEV_COLOR.S2 }}>S2</span> notable ·{' '}
            <span style={{ color: SEV_COLOR.S3 }}>S3</span> routine, digest-only
          </div>
          {learning && (
            <div style={{ opacity: 0.55, marginBottom: 12 }}>
              learning normal: {Math.round((learning.partial / Math.max(1, learning.totalBins)) * 100)}% partial ·{' '}
              {Math.round((learning.mature / Math.max(1, learning.totalBins)) * 100)}% mature ·{' '}
              {learning.totalBins.toLocaleString()} bins
            </div>
          )}
          {signals.length === 0 && <div style={{ opacity: 0.5 }}>No signals recorded.</div>}
          {signals.map((s) => (
            <div key={s.id} style={{ marginBottom: 12, opacity: s.severity === 'S3' ? 0.55 : 1 }}>
              <div>
                <span style={{ color: SEV_COLOR[s.severity], fontWeight: 600 }}>{s.severity}</span>
                {s.demoted_from && <span style={{ opacity: 0.5 }}> (was {s.demoted_from})</span>}
                <span style={{ opacity: 0.5 }}>
                  {' '}· {s.detector} · {new Date(s.ts).toISOString().slice(5, 16).replace('T', ' ')}Z
                </span>
                {s.where && typeof s.where.lat === 'number' && (
                  <span
                    onClick={() => flyTo(s.where.lat, s.where.lon)}
                    style={{ cursor: 'pointer', color: '#4fd8ff', opacity: 0.8, marginLeft: 6 }}
                    title="Point the globe here"
                  >
                    ⤓
                  </span>
                )}
              </div>
              <div>{s.what}</div>
              {s.assessment && (
                <div style={{ marginTop: 2, paddingLeft: 8, borderLeft: '2px solid rgba(79,216,255,0.25)', opacity: 0.85 }}>
                  {s.assessment.disposition} ({Math.round(s.assessment.confidence * 100)}%) — {s.assessment.narrative}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'briefing' && (
        <div>
          {!briefing && <div style={{ opacity: 0.5 }}>No briefing filed yet.</div>}
          {briefing && (
            <>
              <div style={{ opacity: 0.5, marginBottom: 8 }}>
                {briefing.date_local} · filed {new Date(briefing.ts).toISOString().slice(11, 16)}Z
                {briefing.quiet && ' · quiet'}
              </div>
              <div><MarkdownLite text={briefing.body_md} /></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
