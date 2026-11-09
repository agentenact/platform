/** The parameter engine: an edit writes the new value into every binding (data fields only, never code), then re-validates the whole draft. No model involved. */
import { parseSpec } from '../specs/schema.js';
import { BINDABLE_PATHS, checkDraft, parseTime, resolvePointer, storedValue, type DraftResult } from './draft-schema.js';

export function applyParam(d: DraftResult, param: string, value: unknown): { ok: true; draft: DraftResult } | { ok: false; problem: string } {
  const p = d.params.find((x) => x.id === param);
  if (!p) return { ok: false, problem: `there is no parameter ${param}` };
  if (p.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, problem: `${param}: expected a number` };
    if (value < p.min || value > p.max) return { ok: false, problem: `${param}: ${value} is outside ${p.min}..${p.max}` };
  } else if (p.kind === 'choice') {
    if (!p.options.some((o) => o.value === value)) return { ok: false, problem: `${param}: not one of the options` };
  } else if (p.kind === 'time') {
    const t = typeof value === 'string' ? parseTime(value) : null;
    if (!t) return { ok: false, problem: `${param}: expected a time` };
    if ((t.weekday === null) !== (parseTime(p.value)?.weekday === null)) return { ok: false, problem: `${param}: a daily time stays daily and a weekly one weekly` };
    value = `${t.minute} ${t.hour} * * ${t.weekday ?? '*'}`;
  } else if (typeof value !== 'string' || value.length > 100) {
    return { ok: false, problem: `${param}: expected text of at most 100 characters` };
  }

  const draft = structuredClone(d);
  for (const b of draft.bindings) {
    if (b.param !== param) continue;
    const at = resolvePointer(draft.spec, b.path);
    if (!at) return { ok: false, problem: `${param}: ${b.path} does not exist in the description` };
    const stored = storedValue(value, b.scale);
    if (!BINDABLE_PATHS.some((re) => re.test(b.path))) return { ok: false, problem: `${param}: ${b.path} cannot be edited` };
    const cur = Array.isArray(at.parent) ? at.parent[Number(at.key)] : (at.parent as Record<string, unknown>)[at.key];
    if (cur === null || typeof cur === 'object') return { ok: false, problem: `${param}: ${b.path} is not a single value` };
    if (Array.isArray(at.parent)) at.parent[Number(at.key)] = stored;
    else (at.parent as Record<string, unknown>)[at.key] = stored;
  }
  draft.params.find((x) => x.id === param)!.value = value as never;

  const parsed = parseSpec(draft.spec);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  draft.spec = parsed.spec;
  const problem = checkDraft(draft);
  return problem ? { ok: false, problem } : { ok: true, draft };
}
