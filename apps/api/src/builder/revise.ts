/**
 * Revise mode (spec §4.1, P4 Task 18): a new prompt on an existing agent drafts a new description version.
 * The Builder may not set services, hiring, skills, a plan, a webhook or non-Builder tools (scope.ts), so the model
 * never sees the owner's versions of them: `holdBack` strips them from the stored description before the prompt is
 * built, and `restore` copies them back, in code, onto the model's validated answer. Nothing the owner added can be
 * dropped, changed or leaked by a revision.
 */
import { parseSpec, type AgentSpec } from '../specs/schema.js';
import { checkDraft, type DraftResult, type DraftView } from './draft-schema.js';
import { BUILDER_TOOLS } from './scope.js';

export interface Held {
  tools: AgentSpec['tools'];
  services: AgentSpec['services'];
  hire_targets: AgentSpec['hire_targets'];
  skills: AgentSpec['skills'];
  suggested_plan: AgentSpec['suggested_plan'];
  webhookUrl: string | undefined;
  /** The owner's time zone, from the stored schedules: a schedule the model adds reads in it too. */
  tz: string | undefined;
}

const isBuilderTool = (t: string) => (BUILDER_TOOLS as readonly string[]).includes(t);

/** The stored description as the model may see it, and what was held back. `view` null: a minimal one-sentence view. */
export function holdBack(name: string, spec: AgentSpec, view: DraftView | null): { current: DraftResult; held: Held } {
  const held: Held = {
    tools: spec.tools.filter((t) => !isBuilderTool(t)),
    services: structuredClone(spec.services),
    hire_targets: structuredClone(spec.hire_targets),
    skills: structuredClone(spec.skills),
    suggested_plan: [...spec.suggested_plan],
    webhookUrl: spec.delivery.webhook_url,
    tz: spec.triggers.flatMap((t) => (t.kind === 'cron' && t.tz ? [t.tz] : []))[0],
  };
  const { webhook_url: _w, ...delivery } = spec.delivery;
  const stripped: AgentSpec = {
    ...structuredClone(spec),
    tools: spec.tools.filter(isBuilderTool),
    services: [],
    hire_targets: [],
    skills: [],
    suggested_plan: [],
    delivery,
  };
  const v = view ?? { sentence: [name], params: [], bindings: [] };
  return { current: { name, ...structuredClone(v), spec: stripped }, held };
}

/** The model's validated draft with the held-back fields copied back from the stored version, or the first problem. */
export function restore(draft: DraftResult, held: Held): { ok: true; draft: DraftResult } | { ok: false; problem: string } {
  const tools = [...draft.spec.tools, ...held.tools.filter((t) => !draft.spec.tools.includes(t))];
  const parsed = parseSpec({
    ...draft.spec,
    triggers: held.tz ? draft.spec.triggers.map((t) => (t.kind === 'cron' && !t.tz ? { ...t, tz: held.tz } : t)) : draft.spec.triggers,
    tools,
    services: held.services,
    hire_targets: held.hire_targets,
    skills: held.skills,
    suggested_plan: held.suggested_plan,
    delivery: { ...draft.spec.delivery, ...(held.webhookUrl !== undefined ? { webhook_url: held.webhookUrl } : {}) },
  });
  if (!parsed.ok) return parsed;
  const out: DraftResult = { ...draft, spec: parsed.spec };
  const problem = checkDraft(out);
  return problem ? { ok: false, problem } : { ok: true, draft: out };
}
