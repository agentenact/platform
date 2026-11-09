/** What GET /api/agents/:id/spec answers, read into the sentences the screen draws (guarded: an odd answer is null). */
import { asDraft, type DraftData } from './draft-types';
import type { Pending, SpecShown } from './edit';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function version(v: unknown, name: string): { version: number; draft: DraftData; createdAt?: string } | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || typeof v.version !== 'number' || !isObj(v.spec)) return undefined;
  // A description saved without a sentence is shown as its name alone, with nothing to tap.
  const view = isObj(v.view) ? v.view : { sentence: [name], params: [], bindings: [] };
  const draft = asDraft({ name, sentence: view.sentence, params: view.params, bindings: view.bindings, spec: v.spec });
  return draft ? { version: v.version, draft, ...(typeof v.createdAt === 'string' ? { createdAt: v.createdAt } : {}) } : undefined;
}

export function asSpecShown(json: unknown, name: string): SpecShown | null {
  if (!isObj(json)) return null;
  const active = version(json.active, name);
  const draft = version(json.draft, name);
  if (active === undefined || draft === undefined) return null;
  const pending: Pending | null = draft;
  return { active, pending };
}
