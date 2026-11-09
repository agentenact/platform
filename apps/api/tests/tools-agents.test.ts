import { describe, expect, it } from 'bun:test';
import type { ToolSet } from 'ai';
import { encodeRecordHeader, sha256Hex, signRecord, type ChainAdapter, type Settlement } from 'agentenact';
import type { AgentCard, AgentProfile, Discovery } from '../src/discovery/queries.js';
import { createAgentReads } from '../src/tools/agents.js';
import { createToolbox, type ToolboxDeps } from '../src/tools/index.js';
import { fakeSafeFetch } from './support/safe-fetch.js';
import { minimalSpec } from './support/specs.js';

const SELLER = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYER = 'GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'b'.repeat(64);
const USDC = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const settled: Settlement = { chain: 'stellar', ref: TX, payer: PAYER, payee: SELLER, amount: '0.0100000', asset: USDC, at: '2026-10-27T09:59:00Z' };
const hex = (d: Uint8Array) => Buffer.from(d).toString('hex');
const adapter: ChainAdapter = {
  chain: 'stellar',
  sigAlg: 'ed25519',
  async sign(d) { return `${hex(d)}:${SELLER}`; },
  async verify(d, s, a) { return s === `${hex(d)}:${a}`; },
  async readSettlement(ref) { return ref === TX ? [settled] : []; },
  async resolveIdentity() { return { owner: SELLER, wallet: null }; },
};

const card: AgentCard = {
  id: 13, builder: 'hosted', selfPublished: { name: 'Summariser', description: null, service: { slug: 'summary', description: 'Summarise text', priceUsdc: '0.01' } },
  paymentsReceived: 21, usdcReceived: '0.21', lastPaymentAt: null, provenSales: 4, seals: 0, lastActiveAt: '2026-10-26T13:17:57.000Z', karma: null,
  hire: { priceUsdc: '0.01', service: { slug: 'summary', url: 'https://api.agentenact.io/a/u/summary' } },
};
const profile = (o: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 13, owner: 'GOWNER', wallet: SELLER, builder: 'hosted', registered: { at: null, txHash: null, source: 'registry_read' }, lastActiveAt: null,
  totals: { paymentsReceived: 21, usdcReceived: '0.21', provenSales: 4 }, history: [], payments: { source: 'agentkarma', available: true, asOf: null },
  karma: null, selfPublished: { name: 'Summariser', description: null, services: [{ slug: 'summary', description: 'Summarise text', priceUsdc: '0.01', url: null }], fetchedAt: '2026-10-27T00:00:00Z' },
  hire: { priceUsdc: '0.01', service: null }, site: null, hidden: false, links: { karma: 'https://agentkarma.io/x' }, ...o,
});
const agentJson = {
  name: 'Summariser', description: '', agentId: 13, agentWallet: SELLER,
  services: [{ slug: 'summary', description: 'Summarise text', price_usdc: '0.01', url: 'https://api.agentenact.io/a/11111111-1111-4111-8111-111111111111/summary', input_schema: { type: 'object' }, output_schema: null }],
};

function reads(o: { hidden?: boolean; uri?: string; doc?: Response } = {}) {
  const asked: unknown[] = [];
  const discovery: Pick<Discovery, 'agents' | 'profile'> = {
    agents: async (q) => (asked.push(q), { items: [card], next: null, payments: { source: 'agentkarma', available: true, asOf: null } }),
    profile: async (id) => (id === 13 ? profile(o.hidden ? { hidden: true } : {}) : null),
  };
  const fetched: string[] = [];
  const r = createAgentReads({
    discovery,
    agentUri: async () => o.uri ?? 'https://agentenact.io/a/11111111-1111-4111-8111-111111111111/agent.json',
    fetch: async (i) => (fetched.push(String(i)), o.doc ?? new Response(JSON.stringify(agentJson), { status: 200 })),
    adapter,
  });
  return { r, asked, fetched };
}

describe('agent reads', () => {
  it('find: the discovery index, capped at 25, self-published text kept apart', async () => {
    const { r, asked } = reads();
    expect(await r.find({ query: 'summar', limit: 99 })).toEqual({
      network: 'stellar:testnet',
      agents: [{ agent_id: '13', builder: 'hosted', selfPublished: card.selfPublished, for_hire: { price_usdc: '0.01', service: 'summary', url: 'https://api.agentenact.io/a/u/summary' }, proven_sales: 4, last_active_at: '2026-10-26T13:17:57.000Z' }],
      next: null,
    });
    expect(asked).toEqual([{ q: 'summar', limit: 25 }]);
    await r.find({ forHire: true });
    expect(asked[1]).toEqual({ filter: { hire: true }, limit: 10 });
  });
  it('get: chain facts plus the service urls from the agent\'s own document', async () => {
    const { r, fetched } = reads();
    expect(await r.get(13)).toMatchObject({ agent_id: '13', wallet: SELLER, proven_sales: 4, selfPublished: { services: [{ slug: 'summary', url: agentJson.services[0]!.url, priceUsdc: '0.01' }] } });
    expect(fetched).toEqual(['https://agentenact.io/a/11111111-1111-4111-8111-111111111111/agent.json']);
  });
  it('get: an unreadable document falls back to the indexed text, without urls; hidden and unknown agents are not found', async () => {
    expect(await reads({ doc: new Response('nope', { status: 500 }) }).r.get(13)).toMatchObject({ documentError: 'unreadable', selfPublished: { name: 'Summariser', endpoints: [] } });
    expect(await reads({ uri: '' }).r.get(13)).toMatchObject({ documentError: 'no uri' });
    await expect(reads({ hidden: true }).r.get(13)).rejects.toMatchObject({ code: 'agent_not_found' });
    await expect(reads().r.get(14)).rejects.toMatchObject({ code: 'agent_not_found' });
  });
  it('verify: the four checks, the digest, and exact output/input checks', async () => {
    const out = '{"summary":"short"}';
    const rec = await signRecord({
      v: '0.1', agent: { chain: 'stellar', address: SELLER, agentId: '13' },
      input: { sha256: await sha256Hex('{"text":"long"}') }, output: { sha256: await sha256Hex(out), mediaType: 'application/json', bytes: out.length },
      settlement: { chain: 'stellar', ref: TX, payer: PAYER, amount: '0.0100000', asset: USDC }, issuedAt: '2026-10-27T10:00:00Z', nonce: '22'.repeat(16),
    }, adapter, new Uint8Array(32));
    const v = (await reads().r.verify({ record: encodeRecordHeader(rec), output: out, input: '{"text":"other"}' })) as Record<string, unknown>;
    expect(v).toMatchObject({ ok: true, checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' }, hashes: { output: true, input: false } });
    expect(v.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await reads().r.verify({ record: { v: '0.1' } })).toEqual({ ok: false, failure: { check: 'record', reason: 'malformed' } });
  });
});

const run = (t: ToolSet[string] | undefined, input: unknown) => t!.execute!(input as never, { toolCallId: 't1', messages: [] } as never);
function toolbox(o: { hire?: boolean; agents?: boolean; egress?: boolean } = {}) {
  const d: ToolboxDeps = {
    safeFetch: fakeSafeFetch(() => undefined),
    memory: { remember: async () => 'saved' },
    specs: { skillBody: async () => null },
    policy: { delivery: () => true, egress: () => o.egress ?? true, paidSearch: () => true, trialSearch: () => true },
    webhookSecret: () => '00'.repeat(32),
    mailFrom: 'AgentEnact <agents@agentenact.io>',
    env: { RESEND_API_KEY: 'r' },
    ...(o.hire === false ? {} : { hire: async () => ({ ok: false as const, code: 'x' }) }),
    ...(o.agents === false ? {} : { agents: reads().r }),
  };
  return createToolbox(d);
}

describe('orchestration tools in the toolbox', () => {
  const hiring = minimalSpec({ tools: ['hire_agent'] });
  const ctx = (spec = hiring) => ({ agentId: 'a1', ownerEmail: 'o@x.io', mode: 'chat' as const, spec, runId: 'r1' });
  const names = (t: ToolSet) => Object.keys(t).filter((n) => ['find_agents', 'get_agent', 'verify_record'].includes(n));

  it('come only with hire_agent, and never to services', () => {
    expect(names(toolbox().ownerTools(ctx()))).toEqual(['find_agents', 'get_agent', 'verify_record']);
    expect(names(toolbox().ownerTools(ctx(minimalSpec())))).toEqual([]);
    expect(names(toolbox({ hire: false }).ownerTools(ctx()))).toEqual([]);
    expect(names(toolbox({ agents: false }).ownerTools(ctx()))).toEqual([]);
    expect(Object.keys(toolbox().serviceTools('a1', ['web_read']))).toEqual(['web_read']);
  });
  it('call the reads, and count against egress', async () => {
    const tools = toolbox().ownerTools(ctx());
    expect(await run(tools.get_agent, { agent_id: '13' })).toMatchObject({ agent_id: '13' });
    await expect(run(toolbox({ egress: false }).ownerTools(ctx()).find_agents, {})).rejects.toMatchObject({ code: 'egress_limit' });
  });
});
