/**
 * Go/No-Go review (FOUNDATION §11). A reading surface for the one decision
 * the project is built around — assembled entirely from evidence the pipeline
 * already recorded, so the gate is answered from counts rather than memory.
 *
 * Deliberately read-only against the pipeline. The owner's per-incident
 * verdicts live in localStorage: persisting them would mean a schema change
 * on the soak database days before the gate, which is not a trade worth making
 * for a convenience field (DECISIONS #116).
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet } from '../feed/api';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const RED = '#ff5a5a';
const GREEN = '#6be36b';
const DIM = 'rgba(143,163,184,0.85)';

interface GateDay {
  date: string;
  buckets: number;
  coveragePct: number;
  signals: { S1: number; S2: number; S3: number };
  dataHealth: number;
  briefing: { filed: boolean; quiet?: boolean; chars?: number; filedHour?: number };
  analyst: { usd: number; calls: number };
  shadow: { total: number; pushed: number };
}
interface GateStats {
  timezone: string;
  windowDays: number;
  days: GateDay[];
  streak: { current: number; longest: number; gaps: string[] };
}
interface ShadowEntry {
  id: string;
  ts: string;
  signal: { what?: string; detector?: string } | null;
  assessment: { narrative?: string; confidence?: number; disposition?: string } | null;
  would_send: string;
  pushed: boolean;
}

const VERDICT_KEY = 'orrery:gate:verdicts';
type Verdict = 'worth' | 'noise';
function loadVerdicts(): Record<string, Verdict> {
  try {
    return JSON.parse(localStorage.getItem(VERDICT_KEY) ?? '{}') as Record<string, Verdict>;
  } catch {
    return {};
  }
}

const Band = ({ n, q, children }: { n: number; q: string; children: React.ReactNode }) => (
  <div style={{ marginTop: 16 }}>
    <div style={{ color: CYAN, letterSpacing: 1, marginBottom: 2 }}>
      Q{n} · {q}
    </div>
    {children}
  </div>
);

export function GateReview({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<GateStats | null>(null);
  const [shadow, setShadow] = useState<ShadowEntry[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(loadVerdicts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    apiGet<GateStats>('/api/stats/gate?days=14').then((d) => alive && setStats(d)).catch(() => undefined);
    apiGet<{ entries: ShadowEntry[] }>('/api/shadow-log')
      .then((d) => alive && setShadow(d.entries))
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const setVerdict = (id: string, v: Verdict) => {
    setVerdicts((prev) => {
      const next = { ...prev, [id]: v };
      try { localStorage.setItem(VERDICT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // Q1 evidence: things the analyst could not explain away — the closest the
  // record gets to "told me something I wouldn't otherwise know".
  const unexplained = useMemo(
    () => shadow.filter((e) => (e.assessment?.disposition ?? '') === 'unexplained'),
    [shadow],
  );
  const worth = shadow.filter((e) => verdicts[e.id] === 'worth').length;
  const judged = shadow.filter((e) => verdicts[e.id]).length;

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 60 }} />
      <div
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(94vw, 760px)', maxHeight: '86vh', overflowY: 'auto', zIndex: 61,
          font: `11px/1.6 ${mono}`, color: 'rgba(200,214,229,0.92)',
          background: 'rgba(6,10,16,0.98)', border: '1px solid rgba(79,216,255,0.3)',
          borderRadius: 5, padding: '12px 16px 14px', boxShadow: '0 8px 40px rgba(0,0,0,0.75)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ color: CYAN, fontWeight: 600, letterSpacing: 1 }}>GO / NO-GO REVIEW</span>
          <span style={{ opacity: 0.5 }}>FOUNDATION §11 · last {stats?.windowDays ?? 14} days</span>
          <span style={{ flex: 1 }} />
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
        </div>

        {!stats && <div style={{ opacity: 0.5, marginTop: 12 }}>assembling evidence…</div>}

        {stats && (
          <>
            {/* headline */}
            <div style={{ marginTop: 10, display: 'flex', gap: 18, alignItems: 'baseline' }}>
              <span>
                briefing streak{' '}
                <span style={{ color: stats.streak.current >= 7 ? GREEN : AMBER, fontWeight: 600 }}>
                  {stats.streak.current} day{stats.streak.current === 1 ? '' : 's'}
                </span>
                <span style={{ opacity: 0.5 }}> · longest {stats.streak.longest}</span>
              </span>
              {stats.streak.gaps.length > 0 && (
                <span style={{ color: RED, opacity: 0.9 }}>
                  {stats.streak.gaps.length} missed: {stats.streak.gaps.slice(0, 4).join(', ')}
                </span>
              )}
            </div>

            {/* per-day evidence table */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', opacity: 0.45, fontSize: 10, letterSpacing: 0.5 }}>
                <span style={{ width: 86 }}>date</span>
                <span style={{ width: 128 }}>coverage</span>
                <span style={{ width: 96 }}>signals</span>
                <span style={{ width: 120 }}>briefing</span>
                <span>analyst</span>
              </div>
              {stats.days.map((d) => {
                const cov = d.coveragePct;
                const covCol = cov >= 95 ? GREEN : cov >= 70 ? AMBER : RED;
                return (
                  <div key={d.date} style={{ display: 'flex', alignItems: 'center', marginTop: 1 }}>
                    <span style={{ width: 86, opacity: 0.8 }}>{d.date.slice(5)}</span>
                    <span style={{ width: 128, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ display: 'inline-block', width: 64, height: 5, background: 'rgba(143,163,184,0.18)', borderRadius: 2 }}>
                        <span style={{ display: 'block', width: `${Math.min(100, cov)}%`, height: '100%', background: covCol, borderRadius: 2 }} />
                      </span>
                      <span style={{ color: covCol, fontSize: 10 }}>{cov}%</span>
                    </span>
                    <span style={{ width: 96, fontSize: 10 }}>
                      {d.signals.S1 > 0 && <span style={{ color: RED }}>{d.signals.S1}·S1 </span>}
                      {d.signals.S2 > 0 && <span style={{ color: AMBER }}>{d.signals.S2}·S2 </span>}
                      <span style={{ opacity: 0.45 }}>{d.signals.S3}·S3</span>
                    </span>
                    <span style={{ width: 120, fontSize: 10 }}>
                      {!d.briefing.filed ? (
                        <span style={{ color: RED }}>✗ missing</span>
                      ) : d.briefing.filedHour !== undefined && d.briefing.filedHour > 8 ? (
                        <span style={{ color: AMBER }}>⚠ late {String(d.briefing.filedHour).padStart(2, '0')}:00</span>
                      ) : (
                        <span style={{ color: GREEN }}>✓ {d.briefing.quiet ? 'quiet' : 'filed'}</span>
                      )}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.5 }}>
                      {d.analyst.calls > 0 ? `$${d.analyst.usd.toFixed(3)}` : '—'}
                    </span>
                  </div>
                );
              })}
            </div>

            <Band n={1} q="Did the analyst surface something genuinely informative?">
              {unexplained.length === 0 ? (
                <div style={{ opacity: 0.55 }}>
                  No S1 survived triage as unexplained in this window. On the evidence, the honest
                  answer is "not yet" — the instrument has been correctly quiet, which is a finding
                  about the world, not a defect.
                </div>
              ) : (
                unexplained.slice(0, 6).map((e) => (
                  <div key={e.id} style={{ marginTop: 4 }}>
                    <div>{e.signal?.what ?? '—'}</div>
                    {e.assessment?.narrative && (
                      <div style={{ opacity: 0.7, paddingLeft: 8, borderLeft: '2px solid rgba(79,216,255,0.25)' }}>
                        {e.assessment.narrative}
                      </div>
                    )}
                  </div>
                ))
              )}
            </Band>

            <Band n={2} q="Was it opened voluntarily on days when nothing pushed?">
              <div style={{ opacity: 0.55 }}>
                Not instrumented — by choice. ORRERY does not track its owner, so this one is
                yours to answer from memory. The record can only offer the raw material:{' '}
                <span style={{ color: DIM }}>
                  {stats.days.filter((d) => d.signals.S1 === 0 && d.signals.S2 === 0).length} of{' '}
                  {stats.days.length} days had nothing above S3.
                </span>
              </div>
            </Band>

            <Band n={3} q="Was the shadow-mode S1 log worth being interrupted for?">
              {shadow.length === 0 ? (
                <div style={{ opacity: 0.55 }}>
                  A quiet fortnight for the pager that does not exist yet — nothing would have
                  pushed. Push staying dark is the correct behaviour, not a missing feature.
                </div>
              ) : (
                <>
                  <div style={{ opacity: 0.6, marginBottom: 4 }}>
                    {judged > 0
                      ? `${worth} of ${judged} judged worth interrupting for (${shadow.length} total).`
                      : `${shadow.length} would-have-pushed entries. Mark each to build the answer.`}
                  </div>
                  {shadow.slice(0, 12).map((e) => (
                    <div key={e.id} style={{ display: 'flex', gap: 8, marginTop: 3, alignItems: 'baseline' }}>
                      <span style={{ opacity: 0.45, width: 74, fontSize: 10 }}>
                        {new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ')}
                      </span>
                      <span style={{ flex: 1 }}>{e.signal?.what ?? e.would_send.split('\n')[1] ?? '—'}</span>
                      {(['worth', 'noise'] as const).map((v) => (
                        <span
                          key={v}
                          onClick={() => setVerdict(e.id, v)}
                          style={{
                            cursor: 'pointer', fontSize: 10, padding: '0 6px', borderRadius: 3,
                            border: `1px solid ${verdicts[e.id] === v ? (v === 'worth' ? GREEN : DIM) : 'rgba(143,163,184,0.2)'}`,
                            color: verdicts[e.id] === v ? (v === 'worth' ? GREEN : DIM) : 'rgba(143,163,184,0.5)',
                          }}
                        >
                          {v === 'worth' ? 'worth it' : 'noise'}
                        </span>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </Band>

            <div style={{ marginTop: 14, opacity: 0.4, fontSize: 10, lineHeight: 1.5 }}>
              Evidence only. Any "no" to the three questions means ORRERY stops at one layer or
              stops entirely (FOUNDATION §11) — this page does not compute that verdict for you.
            </div>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
