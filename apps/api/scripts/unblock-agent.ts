// Operator only: lift the orphan-limit block on one agent (see src/provision/unblock.ts).
// Usage, from apps/api:  bun scripts/unblock-agent.ts <agent-uuid> [--apply]
// Without --apply it only reads and prints what it would do: would_unblock | refused | nothing_to_do | not_found.
// With --apply it hands the one update to `servel infra sql` against the live database and prints
// unblocked | refused (foreign-owner binding, never lifted here) | nothing_to_do | not_found.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStatement, unblockStatement } from '../src/provision/unblock.js';

const id = process.argv[2] ?? '';
const apply = process.argv.includes('--apply');
let statement: string;
try {
  statement = apply ? unblockStatement(id) : checkStatement(id);
} catch {
  console.error('usage: bun scripts/unblock-agent.ts <agent-uuid> [--apply]');
  process.exit(2);
}

// servel treats an argument as a file only when it ends in .sql.
const dir = await mkdtemp(join(tmpdir(), 'unblock-'));
const file = join(dir, 'unblock.sql');
try {
  await writeFile(file, statement, { mode: 0o600 });
  // From a neutral directory: inside a project servel would read that project's link.
  const p = Bun.spawn(['servel', 'infra', 'sql', '@agentenact-supabase', '--service', 'db', file], { cwd: '/', stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  const result = out.match(/\b(would_unblock|unblocked|refused|nothing_to_do|not_found)\b/)?.[1];
  console.log(result ?? out.trim());
  process.exit(code === 0 && result ? 0 : 1);
} finally {
  await rm(dir, { recursive: true, force: true });
}
