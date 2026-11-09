/**
 * Rewrites the TEMPLATES mirror in src/lib/templates.ts from the api's own list (apps/api/src/builder/templates.ts).
 * Run after the api adds or changes a template: `bun run sync:templates`. tests/create-builder.test.tsx fails on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentTemplates } from '../../api/src/builder/templates';

const file = path.join(import.meta.dir, '..', 'src', 'lib', 'templates.ts');
const src = readFileSync(file, 'utf8');
const start = src.indexOf('export const TEMPLATES: readonly HostedTemplate[] = [');
const end = src.indexOf('\n];\n', start);
if (start < 0 || end < 0) throw new Error('templates.ts: TEMPLATES array not found');

const indent = (s: string, n: number) => s.replace(/\n/g, `\n${' '.repeat(n)}`);
const items = agentTemplates().map(
  (t) =>
    `  {\n    id: ${JSON.stringify(t.id)},\n    title: ${JSON.stringify(t.title)},\n    summary: ${JSON.stringify(t.summary)},\n    draft: ${indent(JSON.stringify(t.draft, null, 2), 4)},\n  },`,
);
writeFileSync(file, `${src.slice(0, start)}export const TEMPLATES: readonly HostedTemplate[] = [\n${items.join('\n')}${src.slice(end)}`);
console.log(`templates.ts: ${items.length} templates`);
