/**
 * What a Builder draft may contain (spec §5). The model's answer is untrusted: the owner approves a plain-words view
 * that hides technical fields, so anything outside this allowlist is refused in code, never left to the prompt.
 * A violation goes back to the model as a repair problem; it is never stripped silently.
 *
 * The Builder may set: name, sentence, params, bindings, spec.persona, spec.system_prompt, spec.triggers,
 * spec.delivery.email and spec.tools within BUILDER_TOOLS. Hiring, selling, skills, a plan and a webhook are the
 * owner's to add later.
 */
import { AgentSpec, type ToolName } from '../specs/schema.js';
import type { DraftResult } from './draft-schema.js';
import { addressFits, CHAINS, EVM_MAX_SINCE_S } from '../tools/wallets.js';
import type { ChainId } from '../tools/schemas.js';

export const BUILDER_TOOLS = ['web_search', 'web_read', 'stellar_price', 'stellar_price_change', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price', 'compute', 'send_email'] as const satisfies readonly ToolName[];

/** The first thing in `s` a draft may not carry, or null. */
export function outsideBuilderScope(s: AgentSpec): string | null {
  if (s.hire_targets.length) return 'hire_targets must be empty: a draft never hires';
  if (s.services.length) return 'services must be empty: selling is suggested later';
  if (s.skills.length) return 'skills must be empty';
  if (s.suggested_plan.length) return 'suggested_plan must be empty';
  if (s.delivery.webhook_url !== undefined) return 'delivery.webhook_url must be absent';
  const bad = s.tools.find((t) => !(BUILDER_TOOLS as readonly string[]).includes(t));
  if (bad) return `tool ${bad} is not available to a draft`;
  return outsideAllowlist(s);
}

/**
 * The positive check: rebuild the spec from the allowed fields only (everything else takes its schema default)
 * and require it to equal the draft. A field added to AgentSpec later fails here until it is reviewed.
 */
function outsideAllowlist(s: AgentSpec): string | null {
  const allowed = AgentSpec.parse({
    persona: s.persona,
    system_prompt: s.system_prompt,
    tools: s.tools.filter((t) => (BUILDER_TOOLS as readonly string[]).includes(t)),
    triggers: s.triggers,
    delivery: { email: s.delivery.email },
  });
  if (Bun.deepEquals(allowed, s)) return null;
  const keys = new Set([...Object.keys(allowed), ...Object.keys(s)]);
  for (const k of keys) {
    if (k === 'delivery') {
      const dk = new Set([...Object.keys(allowed.delivery), ...Object.keys(s.delivery)]);
      for (const d of dk) if (!Bun.deepEquals((allowed.delivery as Record<string, unknown>)[d], (s.delivery as Record<string, unknown>)[d])) return `delivery.${d} is not available to a draft`;
    } else if (!Bun.deepEquals((allowed as Record<string, unknown>)[k], (s as Record<string, unknown>)[k])) return `${k} is not available to a draft`;
  }
  return 'the draft sets a field the Builder may not set';
}

/** Condition rules the prompt asks for, enforced: payments poll with no gap and no repeat; prices ignore stale data. */
export function conditionRuleProblem(s: AgentSpec): string | null {
  for (let i = 0; i < s.triggers.length; i++) {
    const t = s.triggers[i]!;
    if (t.kind !== 'condition') continue;
    if (t.fetch.tool === 'stellar_payments' || t.fetch.tool === 'wallet_payments') {
      const since = typeof t.fetch.args.since_s === 'number' ? t.fetch.args.since_s : 3600;
      if (since < t.every_s) return `trigger ${i}: since_s (${since}) must be at least every_s (${t.every_s}) so a late check leaves no gap`;
      if (t.cooldown_s < since) return `trigger ${i}: cooldown_s (${t.cooldown_s}) must be at least since_s (${since}) so a payment is not reported twice`;
      const chain = t.fetch.args.chain as ChainId | undefined;
      if (t.fetch.tool === 'wallet_payments' && chain && CHAINS[chain].family === 'evm' && since > EVM_MAX_SINCE_S) return `trigger ${i}: on ${chain} since_s (${since}) must be at most ${EVM_MAX_SINCE_S}`;
    }
    if (t.fetch.tool === 'stellar_price_change' && !/\binput\.stale\b/.test(t.code)) return `trigger ${i}: the code must read input.stale so an old price never fires`;
  }
  return null;
}

export const draftScopeProblem = (d: DraftResult): string | null => outsideBuilderScope(d.spec) ?? conditionRuleProblem(d.spec);

/**
 * A wallet that is not an address of the chain its read names. Kept out of draftScopeProblem on purpose: an edit changes the
 * chain and the wallet one tap at a time, so a draft is briefly mismatched between two taps. Checked where a draft becomes
 * final: a model answer and a handoff to sign-up.
 */
export function walletProblem(s: AgentSpec): string | null {
  for (let i = 0; i < s.triggers.length; i++) {
    const t = s.triggers[i]!;
    if (t.kind !== 'condition' || (t.fetch.tool !== 'wallet_payments' && t.fetch.tool !== 'wallet_balance')) continue;
    const { chain, address } = t.fetch.args as { chain: ChainId; address: string };
    if (!addressFits(chain, address)) return `trigger ${i}: ${address} is not a ${CHAINS[chain].label} wallet address`;
  }
  return null;
}
