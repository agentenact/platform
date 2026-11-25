import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ONBOARD_INSTALL, ONBOARD_PROMPT, SKILL_URL } from '../../src/components/onboard-dialog';

const root = join(import.meta.dir, '..', '..');

describe('onboard your agent', () => {
  it('points the prompt at the skill this app serves', () => {
    expect(SKILL_URL).toBe('https://agentenact.io/skill.md');
    expect(ONBOARD_PROMPT).toContain(SKILL_URL);
    const skill = readFileSync(join(root, 'public', 'skill.md'), 'utf8');
    expect(skill.startsWith('---\nname: agentenact\n')).toBe(true);
    // The skill keeps the key out of the chat and the per-call cap in place.
    expect(skill).toContain('Never ask for the key');
    expect(skill).toContain('0.05 USDC');
  });

  it('never sends people to the agentenact npm package', () => {
    expect(ONBOARD_INSTALL).not.toMatch(/-p agentenact|npm i(nstall)? agentenact|bun add agentenact/);
  });

  it('sits in the hero as a secondary action next to Create', () => {
    const hero = readFileSync(join(root, 'src', 'components', 'hero.tsx'), 'utf8');
    expect(hero).toContain('<OnboardDialog />');
    const dialog = readFileSync(join(root, 'src', 'components', 'onboard-dialog.tsx'), 'utf8');
    expect(dialog).toContain('btn btn-quiet');
    expect(dialog).not.toContain('btn-wax');
  });
});

describe('agentenact-mcp setup on /create', () => {
  it('installs from the public repo, never from the npm package that lacks the bin', async () => {
    const s = await import('../../src/lib/snippets');
    expect(s.MCP_INSTALL).toContain('git clone https://github.com/agentenact/mcp.git');
    for (const snippet of [s.MCP_CLAUDE, s.MCP_CODEX, s.MCP_HERMES, s.MCP_JSON]) {
      expect(snippet).not.toContain('npx');
      expect(snippet).toContain('agentenact-mcp/dist/bin/agentenact-mcp.js');
    }
    expect(JSON.parse(s.MCP_JSON).mcpServers.agentenact.command).toBe('node');
  });
});
