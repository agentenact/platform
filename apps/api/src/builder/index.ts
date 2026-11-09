/**
 * Builder.draft (spec §5): one plain sentence in, a validated DraftResult out. One model call, plus one repair call when
 * the answer is not valid. No tools, no network: the model only writes JSON, and every field is checked by code.
 * Never throws.
 */
import { runLoop, type Budget, type LoopInput } from '../loop/run.js';
import type { Ledger } from '../loop/ledger.js';
import type { Models } from '../loop/models.js';
import { emptyUsage, type RunUsage } from '../runs/index.js';
import { checkDraft, DraftResult } from './draft-schema.js';
import { draftScopeProblem, walletProblem } from './scope.js';
import { builderSystem, builderUser, repairUser } from './prompt.js';

export { EXAMPLES } from './examples.js';
export { builderSystem, TOOL_CATALOG } from './prompt.js';

export const BUILDER_BUDGET: Budget = { maxTokens: 60_000, maxOutputTokens: 12_000, maxToolCalls: 0, maxSteps: 1, wallClockMs: 150_000 };

export type DraftOutcome =
  | { ok: true; draft: DraftResult; usage: RunUsage }
  | { ok: false; code: 'unreadable' | 'invalid' | 'model_error' | 'budget' | 'aborted'; usage: RunUsage };

export interface Builder {
  /** `anonymous`: a signed-out visitor, served by the cheap model. Everything else about the call is identical. */
  draft(i: {
    prompt: string;
    current?: DraftResult | null;
    anonymous?: boolean;
    signal?: AbortSignal;
    /** Usage ledger attribution: `edit` is a revision of an existing agent (with `agentId`), `draft` (default) a new description. */
    kind?: 'draft' | 'edit';
    userId?: string;
    agentId?: string;
  }): Promise<DraftOutcome>;
}

type Messages = LoopInput['messages'];

const add = (a: RunUsage, b: RunUsage): RunUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  steps: a.steps + b.steps,
  toolCalls: a.toolCalls + b.toolCalls,
});

/** One ``` fence around the whole answer is allowed. */
const unfence = (t: string) => {
  const m = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t);
  return (m ? m[1]! : t).trim();
};

/** An empty `params` is the same as none, and must be none: {} and absent give different trigger keys. */
function dropEmptyParams(raw: unknown): void {
  const triggers = (raw as { spec?: { triggers?: unknown } } | null)?.spec?.triggers;
  if (!Array.isArray(triggers)) return;
  for (const t of triggers) {
    const p = (t as { params?: unknown } | null)?.params;
    if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) delete (t as { params?: unknown }).params;
  }
}

/** The draft in `text`, or the first problem. */
function parseAnswer(text: string): { ok: true; draft: DraftResult } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(unfence(text));
  } catch {
    return { ok: false, problem: 'the answer is not valid JSON; answer with one JSON object only' };
  }
  dropEmptyParams(raw);
  const r = DraftResult.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, problem: `${i.path.join('.') || 'answer'}: ${i.message}` };
  }
  const problem = checkDraft(r.data) ?? draftScopeProblem(r.data) ?? walletProblem(r.data.spec);
  return problem ? { ok: false, problem } : { ok: true, draft: r.data };
}

export function createBuilder(d: { models: Pick<Models, 'builder' | 'builderAnon'>; ledger?: Ledger }): Builder {
  return {
    async draft(i) {
      const system = builderSystem();
      let usage = emptyUsage();
      const messages: Messages = [{ role: 'user', content: builderUser(i.prompt, i.current) }];
      let problem = '';
      const record = d.ledger?.sink({ kind: i.kind ?? 'draft', ...(i.userId ? { userId: i.userId } : {}), ...(i.agentId ? { agentId: i.agentId } : {}), anon: !!i.anonymous });
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await runLoop({ model: i.anonymous ? d.models.builderAnon : d.models.builder, system, messages, tools: {}, budget: BUILDER_BUDGET, ...(i.signal ? { signal: i.signal } : {}), ...(record ? { record } : {}) });
        usage = add(usage, r.usage);
        if (r.stop === 'length') return { ok: false, code: 'unreadable', usage };
        if (r.stop === 'tokens' || r.stop === 'timeout') return { ok: false, code: 'budget', usage };
        if (r.stop === 'aborted') return { ok: false, code: 'aborted', usage };
        if (r.stop !== 'done') return { ok: false, code: 'model_error', usage };
        const parsed = parseAnswer(r.finalText);
        if (parsed.ok) return { ok: true, draft: parsed.draft, usage };
        problem = parsed.problem;
        messages.push({ role: 'assistant', content: r.finalText }, { role: 'user', content: repairUser(problem) });
      }
      return { ok: false, code: 'invalid', usage };
    },
  };
}
