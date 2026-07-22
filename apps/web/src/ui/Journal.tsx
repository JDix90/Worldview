/**
 * JOURNAL — the diary becomes re-readable (Phase 1 A1, DECISIONS #120).
 * Past briefings newest-first with per-day signal counts; expanding a day
 * shows the full briefing and that day's signals. Deliberately bounded:
 * 30 days, newest first, no search — a journal, not an archive tool.
 *
 * Day scaffolding comes from /api/stats/gate (already computed server-side,
 * so the Journal and the Gate Review can never disagree about which days
 * are missing); a lost briefing renders as a visible gap, not a skipped row
 * — the silently lost 07-17/19 briefings (#116) are exactly what a journal
 * exists to make visible.
 */
import { useEffect, useState } from 'react';
import type { Severity, Signal } from '@orrery/shared';
import { apiGet } from '../feed/api';
import { MarkdownLite } from './FeedPanel';

const CYAN = '#4fd8ff';
const AMBER = '#ffb300';
const RED = '#ff5a5c';
const GREEN = '#6be36b';
const DIM = 'rgba(143,163,184,0.6)';

interface GateDay {
  date: string;
  partial?: boolean;
  signals: { S1: number; S2: number; S3: number };
  briefing: { filed: boolean; quiet?: boolean; filedHour?: number };
}
interface Briefing {
  date_local: string;
  ts: string;
  body_md: string;
  quiet: boolean;
}
interface DaySignal extends Signal {
  assessment: { disposition: string; narrative: string } | null;
}

const SEV_COLOR: Record<Severity, string> = { S1: RED, S2: AMBER, S3: 'rgba(143,163,184,0.55)' };

/** Local-day key for a signal timestamp, in the browser's zone. The server's
 *  `day` filter (post-deploy) uses the briefing timezone; for the owner both
 *  are America/Denver, and the client-side filter keeps the view correct even
 *  against a server that predates the param. */
function dayOf(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DayDetail({ date, briefing }: { date: string; briefing: Briefing | undefined }) {
  const [signals, setSignals] = useState<DaySignal[] | 'loading' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setSignals('loading');
    apiGet<{ signals: DaySignal[] }>(`/api/signals?limit=200&day=${date}`)
      .then((d) => {
        if (!alive) return;
        // Filter client-side too: correct against pre-`day`-param servers,
        // harmless once the param is live.
        setSignals(d.signals.filter((s) => dayOf(s.ts) === date));
      })
      .catch(() => alive && setSignals('error'));
    return () => { alive = false; };
  }, [date]);

  return (
    <div style={{ padding: '6px 0 4px 10px', borderLeft: '2px solid rgba(79,216,255,0.25)', marginBottom: 8 }}>
      {briefing ? (
        <div style={{ marginBottom: 8 }}>
          <MarkdownLite text={briefing.body_md} />
        </div>
      ) : (
        <div style={{ color: RED, opacity: 0.85, marginBottom: 8 }}>
          No briefing exists for this day — the analyst was called but nothing was filed (see DECISIONS #116).
        </div>
      )}
      {signals === 'loading' && <div style={{ opacity: 0.5 }}>loading signals…</div>}
      {signals === 'error' && <div style={{ opacity: 0.5 }}>signal history unavailable</div>}
      {Array.isArray(signals) && signals.length === 0 && (
        <div style={{ opacity: 0.5 }}>no signals recorded this day</div>
      )}
      {Array.isArray(signals) &&
        signals.slice(0, 40).map((s, i) => (
          <div key={i} style={{ opacity: s.severity === 'S3' ? 0.55 : 1, marginBottom: 3 }}>
            <span style={{ color: SEV_COLOR[s.severity] }}>{s.severity}</span>
            <span style={{ opacity: 0.5 }}> · {new Date(s.ts).toISOString().slice(11, 16)}Z · </span>
            {s.what}
            {s.assessment && (
              <span style={{ color: CYAN, opacity: 0.8 }}> › {s.assessment.disposition}</span>
            )}
          </div>
        ))}
      {Array.isArray(signals) && signals.length > 40 && (
        <div style={{ opacity: 0.4 }}>… and {signals.length - 40} more (S3 tail)</div>
      )}
    </div>
  );
}

export function Journal() {
  const [days, setDays] = useState<GateDay[]>([]);
  const [briefings, setBriefings] = useState<Map<string, Briefing>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiGet<{ days: GateDay[]; firstBriefing: string | null }>('/api/stats/gate?days=30'),
      apiGet<{ briefings: Briefing[] }>('/api/briefings?limit=30'),
    ])
      .then(([gate, br]) => {
        if (!alive) return;
        const first = gate.firstBriefing;
        // The journal starts when the instrument started speaking — earlier
        // days are pre-history and would render as misleading empty rows.
        setDays(gate.days.filter((d) => first !== null && d.date >= first));
        setBriefings(new Map(br.briefings.map((b) => [String(b.date_local).slice(0, 10), b])));
      })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  if (failed) return <div style={{ opacity: 0.5 }}>journal unavailable</div>;
  if (days.length === 0) return <div style={{ opacity: 0.5 }}>assembling the record…</div>;

  return (
    <div>
      <div style={{ opacity: 0.45, marginBottom: 10, fontSize: 10 }}>
        every day since the first briefing · click a day to read it
      </div>
      {days.map((d) => {
        const b = briefings.get(d.date);
        const isOpen = expanded === d.date;
        const sig = d.signals;
        return (
          <div key={d.date}>
            <div
              onClick={() => setExpanded(isOpen ? null : d.date)}
              style={{ display: 'flex', gap: 8, cursor: 'pointer', alignItems: 'baseline', padding: '2px 0' }}
            >
              <span style={{ color: isOpen ? CYAN : 'inherit', width: 46 }}>{d.date.slice(5)}</span>
              <span style={{ width: 110, fontSize: 10 }}>
                {sig.S1 > 0 && <span style={{ color: RED }}>{sig.S1}·S1 </span>}
                {sig.S2 > 0 && <span style={{ color: AMBER }}>{sig.S2}·S2 </span>}
                <span style={{ opacity: 0.45 }}>{sig.S3}·S3</span>
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10 }}>
                {d.partial ? (
                  <span style={{ color: DIM }}>in progress</span>
                ) : !d.briefing.filed ? (
                  <span style={{ color: RED }}>✗ no briefing</span>
                ) : (
                  <span style={{ color: d.briefing.quiet ? DIM : GREEN }}>
                    {d.briefing.quiet ? 'quiet' : '✓ filed'}
                    {d.briefing.filedHour !== undefined && d.briefing.filedHour > 8 && (
                      <span style={{ color: AMBER }}> · late</span>
                    )}
                  </span>
                )}
              </span>
              <span style={{ opacity: 0.4 }}>{isOpen ? '▾' : '▸'}</span>
            </div>
            {isOpen && <DayDetail date={d.date} briefing={b} />}
          </div>
        );
      })}
    </div>
  );
}
