/**
 * The /create builder's address-bar state, pure: which entry is selected, which view is open, and which anchors belong to the
 * code view (the old /create sections, so links like /create#own-wallet and /developers keep landing on their part).
 */
import { readTemplateId } from './draft-state';
import { findTemplate, TEMPLATES } from './templates';
import type { DraftData, OptionValue } from './draft-types';
import { coerceValue, readValues, valueText, withValues, type Values } from './template-values';

export type View = 'builder' | 'code';
/** The sidebar's last entry: a free sentence instead of a ready agent. */
export const DESCRIBE = 'describe';

/** Every section of the code view. A hash naming one opens the code view there. */
export const CODE_ANCHORS = ['this-agent', 'install', 'library', 'identity', 'serve', 'verify-record', 'mcp', 'mcp-own', 'own-wallet', 'own-wallet-intro'] as const;

/** The view a location hash asks for: the code view for one of its anchors, else nothing (the address bar decides). */
export function viewForHash(hash: string): View | undefined {
  const id = hash.replace(/^#/, '');
  return (CODE_ANCHORS as readonly string[]).includes(id) ? 'code' : undefined;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** `/create?template=<id>&p.<param>=<value>&view=code`: a known template or "describe" (else the first ready agent), its values, the view. */
export function readBuilderParams(sp: Record<string, string | string[] | undefined>): { selected: string; values: Values; view: View } {
  const raw = first(sp.template);
  const id = raw === DESCRIBE ? DESCRIBE : (findTemplate(readTemplateId(raw))?.id ?? TEMPLATES[0]!.id);
  return { selected: id, values: id === DESCRIBE ? {} : readValues(sp), view: first(sp.view) === 'code' ? 'code' : 'builder' };
}

/** A tap's change in the builder: checked like the draft flow checks it (range, options, length), then bound into the description. Null when it does not fit. */
export function editDraft(d: DraftData, param: string, value: OptionValue): DraftData | null {
  const p = d.params.find((x) => x.id === param);
  if (!p || coerceValue(p, valueText(value)) === null) return null;
  return withValues(d, { [param]: valueText(value) });
}
