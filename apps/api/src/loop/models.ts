/**
 * Models via OpenRouter (spec §2.12): one per role, the Builder's drafts (signed in and anonymous), agent runs, and cheap
 * steps (the web-search fallback). Every role defaults to the cheapest model that drafts and calls tools reliably here,
 * DeepSeek v4.1 flash at $0.045/M in and $0.50/M out (OpenRouter /models, 2026-11-01; Sonnet 5.5 is $2/$10, Opus 5.5
 * $4/$20). MODEL_BUILDER, MODEL_BUILDER_ANON, MODEL_RUN and MODEL_CHEAP override a role with any OpenRouter slug, read
 * once at boot, so switching back (for example MODEL_RUN=anthropic/claude-sonnet-5.5) is an env change and a restart.
 * The only reader of OPENROUTER_API_KEY and ANTHROPIC_API_KEY.
 * Direct Anthropic (Kerem, 2026-11-04: "Anthropici kendi providerindan kullanalim"): with ANTHROPIC_API_KEY set, a picked
 * Anthropic model in ANTHROPIC_DIRECT goes to api.anthropic.com instead of OpenRouter (no OpenRouter credit fee). Anthropic
 * returns tokens, not dollars, so the call's cost is priced here from the table and put on the finish part as
 * providerMetadata.agentenact.costUsd, which loop/ledger.ts reads when OpenRouter's cost is absent. The run records the
 * OpenRouter-style slug either way. Without the key those models go through OpenRouter as before.
 * Metering: `usage.include` makes OpenRouter return token counts and cost on the stream's final chunk, and
 * `compatibility: 'strict'` is what makes the provider send `stream_options.include_usage`. Per-call USD cost is
 * on the `finish` part at providerMetadata.openrouter.usage.cost; loop/ledger.ts reads it into app.model_usage.
 * Prompt caching is not enabled: when wanted, set providerOptions.openrouter.cacheControl (or per-message
 * cache_control) in the loop; OpenRouter then reports cache reads/writes in the same usage chunk.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';

const CHEAPEST = 'deepseek/deepseek-v4.1-flash';
const ROLE_ENV = { builder: 'MODEL_BUILDER', builderAnon: 'MODEL_BUILDER_ANON', run: 'MODEL_RUN', cheap: 'MODEL_CHEAP' } as const;
export type ModelRole = keyof typeof ROLE_ENV;

/** The OpenRouter slug of each role: the env override when set, otherwise the cheapest default. */
export function modelIds(env: Record<string, string | undefined> = process.env): Record<ModelRole, string> {
  const pick = (role: ModelRole) => {
    const v = env[ROLE_ENV[role]]?.trim();
    if (v === undefined || v === '') return CHEAPEST;
    if (!/^[\w.-]+\/[\w.:-]+$/.test(v)) throw new Error(`loop: ${ROLE_ENV[role]} is not an OpenRouter model slug: ${v}`);
    return v;
  };
  return { builder: pick('builder'), builderAnon: pick('builderAnon'), run: pick('run'), cheap: pick('cheap') };
}

export const MODEL_IDS: Readonly<Record<ModelRole, string>> = Object.freeze(modelIds());

export interface Models {
  builder: LanguageModel;
  /** Anonymous (signed-out) drafts; kept its own role so signed-in drafts can move to a stronger model alone. */
  builderAnon: LanguageModel;
  run: LanguageModel;
  cheap: LanguageModel;
  /** Any OpenRouter slug, metered the same way: the model an owner picked for one agent (loop/model-choices.ts). */
  chat(id: string): LanguageModel;
}

/**
 * Anthropic models called directly when ANTHROPIC_API_KEY is set: OpenRouter slug -> Anthropic model id and list prices in
 * USD per million tokens (Anthropic pricing as listed on OpenRouter /models, 2026-11-04). Cache reads bill at 0.1x input,
 * 5-minute cache writes at 1.25x input.
 */
export const ANTHROPIC_DIRECT: Readonly<Record<string, { id: string; inUsd: number; outUsd: number }>> = Object.freeze({
  'anthropic/claude-haiku-5.5': { id: 'claude-haiku-5-5', inUsd: 0.1, outUsd: 0.5 },
  'anthropic/claude-sonnet-5.5': { id: 'claude-sonnet-5-5', inUsd: 2, outUsd: 10 },
  'anthropic/claude-sonnet-5': { id: 'claude-sonnet-5', inUsd: 2, outUsd: 10 },
  'anthropic/claude-opus-5.5': { id: 'claude-opus-5-5', inUsd: 4, outUsd: 20 },
  'anthropic/claude-opus-5': { id: 'claude-opus-5', inUsd: 5, outUsd: 25 },
});

/** The dollar cost of one direct Anthropic call. `input` is the total input (uncached + cache reads + cache writes). */
export function anthropicCost(p: { inUsd: number; outUsd: number }, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const plain = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
  const usd = (plain * p.inUsd + u.cacheRead * p.inUsd * 0.1 + u.cacheWrite * p.inUsd * 1.25 + u.output * p.outUsd) / 1e6;
  return Math.round(usd * 1e9) / 1e9;
}

/** Puts the priced cost on every finish part, and names the model by its OpenRouter slug. */
function priced(model: Parameters<typeof wrapLanguageModel>[0]['model'], slug: string, price: { inUsd: number; outUsd: number }): LanguageModel {
  return wrapLanguageModel({
    model,
    modelId: slug,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => {
        const r = await doStream();
        return {
          ...r,
          stream: r.stream.pipeThrough(
            new TransformStream({
              transform(c, out) {
                if (c.type === 'finish') {
                  const costUsd = anthropicCost(price, {
                    input: c.usage.inputTokens.total ?? 0,
                    output: c.usage.outputTokens.total ?? 0,
                    cacheRead: c.usage.inputTokens.cacheRead ?? 0,
                    cacheWrite: c.usage.inputTokens.cacheWrite ?? 0,
                  });
                  out.enqueue({ ...c, providerMetadata: { ...c.providerMetadata, agentenact: { costUsd } } });
                } else out.enqueue(c);
              },
            }),
          ),
        };
      },
    },
  });
}

export function createModels(env: Record<string, string | undefined> = process.env, o: { fetch?: typeof fetch } = {}): Models {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('loop: OPENROUTER_API_KEY is not set');
  const openrouter = createOpenRouter({
    apiKey,
    compatibility: 'strict',
    appUrl: 'https://agentenact.io',
    appName: 'AgentEnact',
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const anthropic = anthropicKey ? createAnthropic({ apiKey: anthropicKey, ...(o.fetch ? { fetch: o.fetch } : {}) }) : null;
  const viaOpenRouter = (id: string) => openrouter.chat(id, { usage: { include: true } });
  const chat = (id: string): LanguageModel => {
    const direct = ANTHROPIC_DIRECT[id];
    return anthropic && direct ? priced(anthropic(direct.id), id, direct) : viaOpenRouter(id);
  };
  // The role models stay on OpenRouter (their cost comes back with the call); only a per-agent pick may go direct.
  return { builder: viaOpenRouter(MODEL_IDS.builder), builderAnon: viaOpenRouter(MODEL_IDS.builderAnon), run: viaOpenRouter(MODEL_IDS.run), cheap: viaOpenRouter(MODEL_IDS.cheap), chat };
}
