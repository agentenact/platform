/**
 * The usage ledger (app.model_usage): one row per model call, with the dollar cost OpenRouter reports for it.
 * Written from the one place usage is metered (the middleware in `runLoop`), through a `CallSink` bound to who the call is for.
 *
 * Cost is what the call really cost, from OpenRouter's own figures on the stream's last chunk: @openrouter/ai-sdk-provider surfaces
 * `usage.cost` at providerMetadata.openrouter.usage.cost and `cost_details.upstream_inference_cost` at ...usage.costDetails on the
 * `finish` part. A BYOK call (the raw usage's `is_byok`; Anthropic runs on our own key) reports `cost: 0` or only OpenRouter's fee,
 * and the provider bills the upstream amount to us directly, so it costs fee + upstream (seen live 2026-10-16). Otherwise `cost`
 * already includes upstream. When a response carries none, cost is null (tokens only); it is never estimated.
 *
 * A write failure never reaches the caller: it is logged by event, kind, error name and code only (never the message, which may
 * carry a connection string), and the user's request goes on.
 */
import type { Db } from '../db/index.js';

export type CallKind = 'draft' | 'trial' | 'suggest' | 'edit' | 'mission' | 'chat' | 'service';

/** Who a call is for. Builder calls carry a user (or `anon`) and an agent when one exists; agent runs carry the agent and the run. */
export interface CallContext {
  kind: CallKind;
  agentId?: string;
  userId?: string;
  runId?: string;
  /** A signed-out visitor. */
  anon?: boolean;
}

export interface ModelCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD, as reported by the provider; null when it reported none. */
  costUsd: number | null;
}

export type CallSink = (call: ModelCall) => Promise<void>;

export interface Ledger {
  /** Writes one row. Never throws. */
  record(ctx: CallContext, call: ModelCall): Promise<void>;
  /** A sink bound to `ctx`, for `runLoop`'s `record`. */
  sink(ctx: CallContext): CallSink;
}

/** Above this a figure is garbage, not a cost (the column holds up to 999999.999999). */
const MAX_COST = 1e6;

const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COST ? v : null);

/** The call's dollar cost from a finish part's providerMetadata and raw usage (`finish.usage.raw`), or null. */
export function costOf(meta: unknown, raw?: unknown): number | null {
  // A direct provider call (loop/models.ts, Anthropic) carries the cost we priced ourselves.
  const own = usd((meta as { agentenact?: { costUsd?: unknown } } | null | undefined)?.agentenact?.costUsd);
  if (own !== null && (meta as { openrouter?: unknown } | null | undefined)?.openrouter === undefined) return own;
  const u = (meta as { openrouter?: { usage?: { cost?: unknown; costDetails?: { upstreamInferenceCost?: unknown } } } } | null | undefined)?.openrouter?.usage;
  const cost = usd(u?.cost);
  if ((raw as { is_byok?: unknown } | null | undefined)?.is_byok !== true) return cost;
  const upstream = usd(u?.costDetails?.upstreamInferenceCost);
  if (cost === null && upstream === null) return null;
  const total = (cost ?? 0) + (upstream ?? 0);
  return total <= MAX_COST ? total : null;
}

export function createLedger(sql: Db, d: { log: (e: Record<string, unknown>) => void }): Ledger {
  const { log } = d;
  const ledger: Ledger = {
    async record(ctx, c) {
      try {
        await sql`insert into app.model_usage (kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, agent_id, user_id, run_id, anon)
                  values (${ctx.kind}, ${c.model}, ${c.inputTokens}, ${c.outputTokens}, ${c.cacheReadTokens}, ${c.cacheWriteTokens}, ${c.costUsd},
                          ${ctx.agentId ?? null}, ${ctx.userId ?? null}, ${ctx.runId ?? null}, ${ctx.anon ?? false})`;
      } catch (e) {
        const err = e as { name?: unknown; errno?: unknown; code?: unknown } | null;
        const code = typeof err?.errno === 'string' ? err.errno : typeof err?.code === 'string' ? err.code : undefined;
        try {
          log({ event: 'usage_ledger_failed', kind: ctx.kind, name: typeof err?.name === 'string' ? err.name : 'Error', ...(code ? { code } : {}) });
        } catch {
          // logging must not break the request either
        }
      }
    },
    sink: (ctx) => (call) => ledger.record(ctx, call),
  };
  return ledger;
}
