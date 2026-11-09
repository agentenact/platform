import { describe, expect, it } from 'bun:test';
import type { ToolSet } from 'ai';
import type { HireOutcome, HireRequest } from '../src/signer/hire.js';
import { createToolbox, type ToolboxDeps } from '../src/tools/index.js';
import { HireAgentArgs } from '../src/tools/schemas.js';
import { fakeSafeFetch } from './support/safe-fetch.js';
import { minimalSpec } from './support/specs.js';

const run = (t: ToolSet[string] | undefined, input: unknown) => t!.execute!(input as never, { toolCallId: 't1', messages: [] } as never);
const TARGET = 'https://seller.example/a/11111111-1111-4111-8111-111111111111/summary';

const settled: HireOutcome = { ok: true, status: 200, output: { a: 1 }, payment: 'settled', transaction: 'e'.repeat(64), paidUsdc: '0.0010000', record: 'verified', failedChecks: [], consistent: true };
function toolbox(hires: HireRequest[], outcome: HireOutcome = settled) {
  const d: ToolboxDeps = {
    safeFetch: fakeSafeFetch(() => undefined),
    memory: { remember: async () => 'saved' },
    specs: { skillBody: async () => null },
    policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true },
    webhookSecret: () => '00'.repeat(32),
    mailFrom: 'AgentEnact <agents@agentenact.io>',
    env: { RESEND_API_KEY: 'r' },
    hire: async (r) => (hires.push(r), outcome),
  };
  return createToolbox(d);
}

describe('hire_agent', () => {
  const spec = minimalSpec({ tools: ['hire_agent'], hire_targets: [{ url: TARGET, max_usdc: '0.02' }] });

  it('is offered only when the spec lists it, and never to services', () => {
    const tb = toolbox([]);
    expect(Object.keys(tb.ownerTools({ agentId: 'a', ownerEmail: 'o@x.io', mode: 'chat', spec, runId: 'r' }))).toContain('hire_agent');
    expect(Object.keys(tb.ownerTools({ agentId: 'a', ownerEmail: 'o@x.io', mode: 'chat', spec: minimalSpec(), runId: 'r' }))).not.toContain('hire_agent');
    expect(Object.keys(tb.serviceTools('a', ['web_read']))).toEqual(['web_read']);
  });

  it('a mission may hire only an approved target, at that target cap', async () => {
    const hires: HireRequest[] = [];
    const tools = toolbox(hires).ownerTools({ agentId: 'a1', ownerEmail: 'o@x.io', mode: 'mission', spec, runId: 'run-1' });
    await expect(run(tools.hire_agent, { url: 'https://other.example/a/x/y', input: {} })).rejects.toMatchObject({ code: 'target_not_approved' });
    expect(await run(tools.hire_agent, { url: TARGET, input: { q: 'xlm' } })).toEqual({ status: 200, output: { a: 1 }, payment: 'settled', transaction: 'e'.repeat(64), paid_usdc: '0.0010000', record: 'verified', failed_checks: [], consistent: true });
    expect(hires).toEqual([{ agentId: 'a1', runId: 'run-1', mode: 'mission', url: TARGET, input: { q: 'xlm' }, maxUsdc: '0.02' }]);
  });

  it('a chat may hire any https URL (http only on loopback) at the per-call cap', async () => {
    const hires: HireRequest[] = [];
    const tools = toolbox(hires).ownerTools({ agentId: 'a1', ownerEmail: 'o@x.io', mode: 'chat', spec, runId: 'run-2' });
    await run(tools.hire_agent, { url: 'https://other.example/a/x/y', input: 'hello' });
    expect(hires[0]).toMatchObject({ mode: 'chat', url: 'https://other.example/a/x/y', maxUsdc: '0.05', input: 'hello' });
    // The AI SDK validates tool input against the schema before execute: only https URLs (plain http on loopback) reach it.
    expect(HireAgentArgs.safeParse({ url: 'ftp://x.example/', input: {} }).success).toBe(false);
    expect(HireAgentArgs.safeParse({ url: 'http://x.example/', input: {} }).success).toBe(false);
    expect(HireAgentArgs.safeParse({ url: 'http://localhost:8080/a/x/y', input: {} }).success).toBe(true); // loopback: local tests only; safeFetch refuses it in production
  });

  it('an unknown payment shows the model the amount and no transaction; a payment failure still reports the money state', async () => {
    const ctx = { agentId: 'a1', ownerEmail: 'o@x.io', mode: 'chat' as const, spec, runId: 'run-3' };
    const unknown: HireOutcome = { ok: true, status: 200, output: 'x', payment: 'unknown', transaction: null, paidUsdc: '0.0010000', record: 'inconsistent', failedChecks: ['settlement'], consistent: false };
    expect(await run(toolbox([], unknown).ownerTools(ctx).hire_agent, { url: TARGET, input: {} })).toEqual({ status: 200, output: 'x', payment: 'unknown', transaction: null, paid_usdc: '0.0010000', record: 'inconsistent', failed_checks: ['settlement'], consistent: false });
    const failedPaid: HireOutcome = { ok: false, code: 'verify_failed', payment: 'unknown', paidUsdc: '0.0010000' };
    expect(await run(toolbox([], failedPaid).ownerTools(ctx).hire_agent, { url: TARGET, input: {} })).toEqual({ error: 'verify_failed', payment: 'unknown', transaction: null, paid_usdc: '0.0010000' });
    await expect(run(toolbox([], { ok: false, code: 'cap_reached' }).ownerTools(ctx).hire_agent, { url: TARGET, input: {} })).rejects.toMatchObject({ code: 'cap_reached' });
  });

  it('needs a run id and a configured hirer', async () => {
    const tools = toolbox([]).ownerTools({ agentId: 'a1', ownerEmail: 'o@x.io', mode: 'chat', spec });
    await expect(run(tools.hire_agent, { url: TARGET, input: {} })).rejects.toMatchObject({ code: 'hire_unavailable' });
  });
});