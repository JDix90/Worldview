/**
 * Triage: Haiku assesses each S1/S2 Signal — explained / unexplained / noise.
 * May web-search (budget-gated per day). The honesty rule (FOUNDATION §8) is
 * mechanical here: sources_consulted comes from the API's citation blocks,
 * never from what the model claims; severity_final is clamped in code so an
 * upgrade is impossible regardless of model output.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Assessment, Severity, Signal } from '@orrery/shared';

const SEVERITY_RANK: Record<Severity, number> = { S1: 3, S2: 2, S3: 1 };

export const TRIAGE_SYSTEM = `You are the analyst stage of ORRERY, a personal flight-anomaly instrument. You receive one structured Signal produced by a deterministic detector, and you decide what it means.

Rules:
- Distinguish observed (the data says), inferred (this pattern usually means), and unknown (no explanation found). Never present inference as fact.
- If web search is available to you, use it only when news coverage could plausibly explain the signal. If you find an explanation, disposition is "explained". If you searched and found nothing, disposition is "unexplained" — say plainly that no public reporting was found.
- If the signal looks like sensor noise, coverage artifact, or routine operations (a single medical diversion, a transponder test), disposition is "noise".
- You may lower the severity (severity_final), never raise it.
- Never claim to have checked a source you did not actually consult in this conversation. You have no NOTAM access.
- Be laconic. No exclamation points, no drama.

End your reply with exactly one JSON object in a \`\`\`json fence:
{"disposition": "explained"|"unexplained"|"noise", "severity_final": "S1"|"S2"|"S3", "narrative": "<2-4 dry sentences>", "confidence": <0..1>}`;

export function buildTriagePrompt(signal: Signal): string {
  return `Signal to assess:\n\`\`\`json\n${JSON.stringify(signal, null, 2)}\n\`\`\`\nCurrent UTC time: ${new Date().toISOString()}.`;
}

/** URLs the model actually cited, straight from the response blocks. */
export function extractConsultedSources(content: Anthropic.ContentBlock[]): string[] {
  const urls = new Set<string>();
  for (const block of content) {
    if (block.type === 'text' && block.citations) {
      for (const c of block.citations) {
        if ('url' in c && typeof c.url === 'string') urls.add(c.url);
      }
    }
  }
  return [...urls];
}

export function parseAssessment(
  content: Anthropic.ContentBlock[],
  signal: Signal,
  model: string,
): Assessment {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = fences[fences.length - 1];
  if (!last) throw new Error('triage response contained no json fence');
  const raw = JSON.parse(last[1]!) as {
    disposition: Assessment['disposition'];
    severity_final: Severity;
    narrative: string;
    confidence: number;
  };
  if (!['explained', 'unexplained', 'noise'].includes(raw.disposition)) {
    throw new Error(`bad disposition: ${raw.disposition}`);
  }

  // downgrade-only, enforced here — the model cannot upgrade severity
  let severityFinal: Severity = raw.severity_final;
  if (!SEVERITY_RANK[severityFinal] || SEVERITY_RANK[severityFinal] > SEVERITY_RANK[signal.severity]) {
    severityFinal = signal.severity;
  }

  return {
    signal_id: signal.id,
    disposition: raw.disposition,
    severity_final: severityFinal,
    narrative: String(raw.narrative).slice(0, 2000),
    sources_consulted: extractConsultedSources(content),
    confidence: Math.min(Math.max(Number(raw.confidence) || 0, 0), 1),
  };
}

export function webSearchTool(maxUses: number): Anthropic.WebSearchTool20250305 {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses };
}
