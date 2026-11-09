import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { HorizonReader } from '../src/chain/horizon.js';
import type { RegistryAgent, RegistryReader } from '../src/chain/registry.js';
import { createLoop } from '../src/loop.js';
import { buildStages } from '../src/stages.js';
import { freshDb } from './support/db.js';
import { OWNER, REGISTRY, USDC, WALLET } from './support/fake-chain.js';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

const BASE = 'https://agentenact.io';
const config = { registry: REGISTRY, publicBaseUrl: BASE, usdc: USDC, sponsors: [] as string[] };

function reader(agents: RegistryAgent[], over: Partial<RegistryReader> = {}): RegistryReader {
  return {
    async totalAgents() {
      return agents.length;
    },
    async read(id) {
      return agents[id] ?? null;
    },
    async latestLedger() {
      return 100;
    },
    async events() {
      return { events: [], cursor: null, latestLedger: 100 };
    },
    ...over,
  };
}
let horizonCalls = 0;
const horizon: HorizonReader = {
  async accountPayments(_w, cursor) {
    horizonCalls++;
    return { transfers: [], cursor, done: true };
  },
};
const agent = (agentId: number): RegistryAgent => ({ agentId, owner: OWNER, wallet: WALLET, uri: '' });
const clear = async () => {
  await db.sql`delete from discovery.agents`;
  await db.sql`delete from discovery.meta`;
};

describe('buildStages', () => {
  it('passes the pinned registry to reconcile: a different pinned contract id is a chain reset', async () => {
    await clear();
    await db.sql`insert into discovery.meta (key, value) values ('registry_contract', 'CSOMEOTHERCONTRACT')`;
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: () => {} });
    expect(await stages.registry()).toMatchObject({ status: 'chain_reset' });
  });

  it('pins the configured registry on the first reconcile', async () => {
    await clear();
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: () => {} });
    expect(await stages.registry()).toMatchObject({ status: 'ok' });
    expect(((await db.sql`select value from discovery.meta where key = 'registry_contract'`) as Array<{ value: string }>)[0]?.value).toBe(REGISTRY);
  });

  it('the events stage passes the pin too (followRegistry reconciles on its first run)', async () => {
    await clear();
    await db.sql`insert into discovery.meta (key, value) values ('registry_contract', 'CSOMEOTHERCONTRACT')`;
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: () => {} });
    expect(await stages.events()).toMatchObject({ status: 'chain_reset' });
  });

  it('wires selfpub with the fixed public base url: a hosted-looking uri on another host is never fetched', async () => {
    await clear();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (0, ${OWNER}, ${WALLET}, 'https://evil.example/a/0b9f3c1e-2d4a-4e5f-8a6b-7c8d9e0f1a2b/agent.json', 'registry_read')`;
    const real = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: () => {} });
      await stages.selfpub();
    } finally {
      globalThis.fetch = real;
    }
    expect(fetched).toBe(0);
  });

  it('end to end: a reset found by the registry stage halts the real events and payments stages', async () => {
    await clear();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (0, ${OWNER}, ${WALLET}, '', 'registry_read')`;
    await db.sql`insert into discovery.meta (key, value) values ('registry_contract', ${REGISTRY})`;
    // the chain now has no agents but we hold agent 0: total_below_held
    const logs: Array<Record<string, string | number>> = [];
    horizonCalls = 0;
    const stages = buildStages({ sql: db.sql, reader: reader([]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: (e) => void logs.push(e) });
    const loop = createLoop({ stages, sql: db.sql, lock: { assertHeld: async () => true }, exit: () => {}, log: (e) => void logs.push(e) });
    await loop.tick('registry');
    await loop.tick('payments');
    await loop.tick('events');
    expect(horizonCalls).toBe(0);
    expect(logs.filter((l) => l.event === 'indexer_halted').length).toBe(1);
    expect(((await db.sql`select value from discovery.meta where key = 'events_ledger'`) as unknown[]).length).toBe(0);
  });

  it('end to end: a reset returned by the events stage halts payments', async () => {
    await clear();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (0, ${OWNER}, ${WALLET}, '', 'registry_read')`;
    await db.sql`insert into discovery.meta (key, value) values ('events_ledger', '500')`;
    horizonCalls = 0;
    const logs: Array<Record<string, string | number>> = [];
    // the rpc is behind what we processed: ledger_regressed
    let t = Date.parse('2026-10-15T12:00:00Z');
    const now = () => new Date(t);
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, now, log: () => {} });
    const loop = createLoop({ stages, sql: db.sql, lock: { assertHeld: async () => true }, exit: () => {}, log: (e) => void logs.push(e) });
    // one lagging sample is not a reset: the first two ticks only look, and payments stay off (events never proved the chain)
    for (const step of [0, 10_000, 10_000]) {
      t += step;
      await loop.tick('events');
      await loop.tick('payments');
    }
    expect(horizonCalls).toBe(0);
    expect(logs.filter((l) => l.event === 'indexer_halted').length).toBe(1);
  });

  it('a stored ledger above the chain latest halts on the first registry tick and writes no agent rows', async () => {
    await clear();
    // no halted marker; the events stage had processed ledger 500 and the chain now reports 100
    await db.sql`insert into discovery.meta (key, value) values ('events_ledger', '500')`;
    const logs: Array<Record<string, string | number>> = [];
    horizonCalls = 0;
    let t = Date.parse('2026-10-15T12:00:00Z');
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0), agent(1)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, now: () => new Date(t), log: (e) => void logs.push(e) });
    const loop = createLoop({ stages, sql: db.sql, lock: { assertHeld: async () => true }, exit: () => {}, log: (e) => void logs.push(e) });
    // 500 vs 100 on every sample: suspect twice (no agent rows meanwhile), a reset on the third sample 20 s in
    await loop.tick('registry');
    expect(((await db.sql`select value from discovery.meta where key = 'halted'`) as unknown[]).length).toBe(0);
    t += 10_000;
    await loop.tick('registry');
    t += 10_000;
    await loop.tick('registry');
    await loop.tick('events');
    await loop.tick('payments');
    expect(((await db.sql`select agent_id from discovery.agents`) as unknown[]).length).toBe(0);
    expect(((await db.sql`select value from discovery.meta where key = 'registry_contract'`) as unknown[]).length).toBe(0);
    expect(((await db.sql`select value from discovery.meta where key = 'halted'`) as Array<{ value: string }>)[0]?.value).toBe('chain_reset');
    expect(logs.filter((l) => l.event === 'indexer_halted').length).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'registry_chain_reset', signal: 'ledger_regressed' }));
    expect(horizonCalls).toBe(0);
  });

  it('payments run when nothing is halted', async () => {
    await clear();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (0, ${OWNER}, ${WALLET}, '', 'registry_read')`;
    horizonCalls = 0;
    const stages = buildStages({ sql: db.sql, reader: reader([agent(0)]), horizon, config, verify: async () => { throw new Error('no chain in this test'); }, log: () => {} });
    const loop = createLoop({ stages, sql: db.sql, lock: { assertHeld: async () => true }, exit: () => {}, log: () => {} });
    await loop.tick('events'); // payments waits for one successful events tick
    await loop.tick('payments');
    expect(horizonCalls).toBe(1);
  });

  it('the records stage verifies stored submissions with the injected verifier', async () => {
    await clear();
    await db.sql.unsafe('delete from discovery.submissions');
    let seen = 0;
    const stages = buildStages({
      sql: db.sql, reader: reader([]), horizon, config, log: () => {},
      verify: async () => (seen++, { ok: false, checks: { signature: 'fail', settlement: 'skipped', timing: 'skipped', identity: 'skipped' }, failure: { check: 'signature', reason: 'invalid_signature' } }),
    });
    const r = { v: '0.1', agent: { chain: 'stellar', address: WALLET }, input: { sha256: 'a'.repeat(64) }, output: { sha256: 'b'.repeat(64) }, settlement: { chain: 'stellar', ref: 'c'.repeat(64), payer: OWNER, amount: '0.001', asset: USDC }, issuedAt: '2026-10-12T12:00:00Z', nonce: 'd'.repeat(32), sig: { alg: 'ed25519', value: 'ab' } };
    const { recordDigest, parseRecord } = await import('agentenact');
    const digest = Buffer.from(await recordDigest(parseRecord(r))).toString('hex');
    await db.sql`insert into discovery.submissions (digest, record) values (${digest}, ${r as unknown as Record<string, unknown>})`;
    expect(await stages.records()).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(seen).toBe(1);
  });
});
