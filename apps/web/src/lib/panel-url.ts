/**
 * Where the ask, the ready agents and the builder hand over to the draft flow. Since the site and the panel are one app, these
 * are same-origin relative paths; `PANEL` is the empty prefix (it was https://app.agentenact.io before the merge).
 */
import { valueEntries, type Values } from './template-values';

export const PANEL = '';

/** Same cap as the draft flow's own prompt box (lib/draft-state.ts clampPrompt). */
const MAX_PROMPT = 500;

/** `/draft?prompt=` with the trimmed first 500 characters; a blank prompt opens `/create`, where the header's "Create an agent" goes. */
export function panelUrl(prompt: string): string {
  const text = prompt.trim().slice(0, MAX_PROMPT).trim();
  if (!text) return `${PANEL}/create`;
  return `${PANEL}/draft?${new URLSearchParams({ prompt: text })}`;
}

/**
 * `/draft?template=`: the draft flow opens a ready agent's plan at once, with no model call. `values` (`p.<param>=`) are the
 * builder's changes; the draft flow applies them with the same edit a tap makes.
 */
export function templateUrl(id: string, values: Values = {}): string {
  return `${PANEL}/draft?${new URLSearchParams([['template', id], ...valueEntries(values)])}`;
}

/** `/create`, the builder: a template (and its values) selected, the code view when asked. */
export function builderUrl(o: { template?: string | undefined; values?: Values; view?: 'builder' | 'code' } = {}): string {
  const q = new URLSearchParams([...(o.template ? [['template', o.template]] : []), ...valueEntries(o.values ?? {}), ...(o.view === 'code' ? [['view', 'code']] : [])]);
  const s = q.toString();
  return `${PANEL}/create${s ? `?${s}` : ''}`;
}
