/** Pure import scanners used by the architecture invariants. */

const STATIC_FROM = /(?:^|[\s;}])(?:import|export)\s+(type\s+)?[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier the file loads: static, dynamic and bare imports, type-only included. */
export function allImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STATIC_FROM)) out.push(m[2]!);
  for (const m of text.matchAll(SIDE_EFFECT)) out.push(m[1]!);
  for (const m of text.matchAll(DYNAMIC)) out.push(m[1]!);
  return out;
}

/** Runtime imports only: `import type …` / `export type … from` are erased; dynamic and bare imports count. */
export function valueImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STATIC_FROM)) if (!m[1]) out.push(m[2]!);
  for (const m of text.matchAll(SIDE_EFFECT)) out.push(m[1]!);
  for (const m of text.matchAll(DYNAMIC)) out.push(m[1]!);
  return out;
}
