/**
 * Stage 4 plumbing: the Anthropic client behind a cost ledger and circuit
 * breaker. Every call is priced and recorded BEFORE the next is allowed; at
 * the monthly cap the analyst degrades to "unavailable — spend cap", never a
 * surprise invoice (FOUNDATION §8).
 *
 * The transport is injectable so verify scripts exercise everything below
 * the API line without spending a cent.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ulid } from '@orrery/shared';
import type { Queryable } from '../db.js';
import { env } from '../env.js';
import { log } from '../log.js';

/** USD per MTok in/out. Unknown models fall back to the most expensive row. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 3, out: 15 },
};
const FALLBACK_PRICE = { in: 3, out: 15 };
const WEB_SEARCH_USD_PER_CALL = 0.01;

export interface AnalystCallResult {
  content: Anthropic.ContentBlock[];
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  estCostUsd: number;
}

export type Transport = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export function priceOf(model: string): { in: number; out: number } {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key]! : FALLBACK_PRICE;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  webSearches: number,
): number {
  const p = priceOf(model);
  return (
    (inputTokens / 1_000_000) * p.in +
    (outputTokens / 1_000_000) * p.out +
    webSearches * WEB_SEARCH_USD_PER_CALL
  );
}

export class AnalystClient {
  private transport: Transport;

  constructor(
    private db: Queryable,
    transport?: Transport,
  ) {
    if (transport) {
      this.transport = transport;
    } else {
      const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
      this.transport = (params) => anthropic.messages.create(params);
    }
  }

  get configured(): boolean {
    return env.anthropicApiKey !== '' || this.transportInjected;
  }
  private transportInjected = false;
  static withTransport(db: Queryable, transport: Transport): AnalystClient {
    const c = new AnalystClient(db, transport);
    c.transportInjected = true;
    return c;
  }

  async monthToDateUsd(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT coalesce(sum(est_cost_usd), 0)::float8 AS usd
       FROM analyst_usage WHERE ts >= date_trunc('month', now())`,
    );
    return Number(rows[0].usd);
  }

  /** True when the monthly cap is spent — callers must degrade, not retry. */
  async breakerTripped(): Promise<boolean> {
    return (await this.monthToDateUsd()) >= env.monthlySpendCapUsd;
  }

  async call(
    kind: 'triage' | 'briefing',
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<AnalystCallResult> {
    const msg = await this.transport(params);
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const webSearches = msg.usage.server_tool_use?.web_search_requests ?? 0;
    const estCostUsd = estimateCostUsd(params.model, inputTokens, outputTokens, webSearches);
    await this.db.query(
      `INSERT INTO analyst_usage (id, ts, kind, model, input_tokens, output_tokens, web_searches, est_cost_usd)
       VALUES ($1, now(), $2, $3, $4, $5, $6, $7)`,
      [ulid(), kind, params.model, inputTokens, outputTokens, webSearches, estCostUsd],
    );
    log('analyst', `${kind} call`, {
      model: params.model,
      inputTokens,
      outputTokens,
      webSearches,
      estCostUsd: Number(estCostUsd.toFixed(4)),
    });
    return { content: msg.content, inputTokens, outputTokens, webSearches, estCostUsd };
  }
}
