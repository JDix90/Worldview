/**
 * The feed panel (FOUNDATION §4): S2 badges, S3 dim, S1 loud; assessments
 * inline; briefing tab. Collapsed by default — the globe is the instrument,
 * this is its margin notes. Polls the API at 60s.
 */
import { useEffect, useState } from 'react';
import type { Severity, Signal } from '@orrery/shared';
import { apiGet } from '../feed/api';

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

export function FeedPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'signals' | 'briefing'>('signals');
  const [signals, setSignals] = useState<FeedSignal[]>([]);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [cost, setCost] = useState<{ mtd_usd: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      apiGet<{ signals: FeedSignal[] }>('/api/signals?limit=50')
        .then((d) => alive && setSignals(d.signals))
        .catch(() => undefined);
      apiGet<{ briefings: Briefing[] }>('/api/briefings?limit=1')
        .then((d) => alive && setBriefing(d.briefings[0] ?? null))
        .catch(() => undefined);
      apiGet<{ monthToDate: { mtd_usd: number } }>('/api/analyst/usage')
        .then((d) => alive && setCost(d.monthToDate))
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const dayAgo = Date.now() - 86_400_000;
  const badge = signals.filter(
    (s) => (s.severity === 'S2' || s.severity === 'S1') && new Date(s.ts).getTime() > dayAgo,
  ).length;

  if (!open) {
    return (
      <div
        onClick={() => setOpen(true)}
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
        {cost && <span style={{ opacity: 0.45 }}>${cost.mtd_usd.toFixed(2)} mtd</span>}
        <span onClick={() => setOpen(false)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
      </div>

      {tab === 'signals' && (
        <div>
          {signals.length === 0 && <div style={{ opacity: 0.5 }}>No signals recorded.</div>}
          {signals.map((s) => (
            <div key={s.id} style={{ marginBottom: 12, opacity: s.severity === 'S3' ? 0.55 : 1 }}>
              <div>
                <span style={{ color: SEV_COLOR[s.severity], fontWeight: 600 }}>{s.severity}</span>
                {s.demoted_from && <span style={{ opacity: 0.5 }}> (was {s.demoted_from})</span>}
                <span style={{ opacity: 0.5 }}>
                  {' '}· {s.detector} · {new Date(s.ts).toISOString().slice(5, 16).replace('T', ' ')}Z
                </span>
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
              <div style={{ whiteSpace: 'pre-wrap' }}>{briefing.body_md}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
