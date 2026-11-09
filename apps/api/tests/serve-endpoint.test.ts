import { encodePaymentSignatureHeader } from '@x402/core/http';
import { createServiceMcp } from '../src/signer/mcp.js';
import { DELEGATION_HEADER, encodeDelegation } from 'agentenact/orchestrate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { decodePaymentResponseHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { decodeRecordHeader, ENACTMENT_HEADER, sha256Hex, verifyRecord, type EnactmentRecord } from 'agentenact';
import type { X402Server } from 'agentenact/serve';
import type { Db } from '../src/db/index.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { createServiceRunner } from '../src/loop/service.js';
import type { ToolSet } from 'ai';
import { createRecords } from '../src/records/index.js';
import { createRuns } from '../src/runs/index.js';
import { createServiceEndpoint, DELEGATION_MAX_DEPTH, priceOf, type ServeDeps, type ServiceRunner } from '../src/signer/serve.js';
import { createSpecs } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { activeAgent, minimalSpec } from './support/specs.js';
import { fakeX402, PAYER, settlementAdapter, TX } from './support/x402.js';

const BASE = 'https://public.example.test';
const IN = { type: 'object' as const, required: ['text'], properties: { text: { type: 'string' as const, maxLength: 1000 } } };
const OUT = { type: 'object' as const, required: ['summary'], properties: { summary: { type: 'string' as const } } };

describe('paid service endpoint', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }) }));
  });
  afterAll(() => drop());
  // The fake facilitator settles every call as the same TX; the vault signs one record per settlement, so each test starts clean.
  beforeEach(async () => void (await sql`delete from keyvault.signatures where kind = 'record'`));

  /** An active agent whose stellar_address is its real key, with a live 0.01 USDC service 'summary'. */
  async function seller() {
    const a = await activeAgent(sql);
    const { publicKey } = await keys.generate(a.agentId);
    await sql`update app.agents set stellar_address = ${publicKey} where id = ${a.agentId}`;
    const specs = createSpecs(sql);
    const spec = minimalSpec({ services: [{ slug: 'summary', description: 'Summarise', price_usdc: '0.01', input_schema: IN, output_schema: OUT, persona: 'p', skill_body: '', tools: [] }] });
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, spec));
    return { ...a, address: publicKey };
  }

  function endpoint(s: { address: string }, over: Partial<ServeDeps> & { x?: X402Server & { settled: number; verified: number } } = {}) {
    const x = over.x ?? fakeX402(s.address);
    const settledRuns: [string, string, string][] = [];
    const secretsOpened = { n: 0 };
    const factoryCalls: string[] = [];
    const runCalls: { svcId: string; userId: string }[] = [];
    const runService: ServiceRunner = async (svc, userId, input) => (runCalls.push({ svcId: svc.id, userId }), { runId: crypto.randomUUID(), output: { summary: `got ${(input as { text: string }).text}` } });
    const ep = createServiceEndpoint({
      sql,
      keys: { publicKey: (id) => keys.publicKey(id), recordSigner: (id) => { const sign = keys.recordSigner(id); return async (u) => (secretsOpened.n++, sign(u)); } },
      specs: createSpecs(sql),
      runs: { settle: async (id, tx, earned) => (settledRuns.push([id, tx, earned]), true) },
      records: { save: async () => true }, // tests that look at stored records pass the real one
      runService,
      killed: false,
      publicBaseUrl: BASE,
      env: { OZ_API_KEY: 'test-oz' },
      x402Factory: async (o) => (factoryCalls.push(o.price), x),
      adapter: settlementAdapter(s.address),
      ...over,
    });
    return { ep, x, settledRuns, secretsOpened, factoryCalls, runCalls };
  }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE}/a/x/summary`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('normalizes the price', () => {
    expect([priceOf('0.0100000'), priceOf('1.0000000'), priceOf('0.0010000')]).toEqual(['0.01', '1', '0.001']);
  });

  it('refuses to start without the facilitator key', () => {
    expect(() => createServiceEndpoint({ sql, keys, specs: createSpecs(sql), runs: createRuns(sql), records: createRecords(sql), runService: async () => ({ runId: '', output: null }), killed: false, publicBaseUrl: BASE, env: {} })).toThrow('signer: OZ_API_KEY is not set');
  });

  it('404s unknown agents, services that are off and agents that are not active, before touching payments', async () => {
    const s = await seller();
    const { ep, factoryCalls, x } = endpoint(s);
    expect((await ep.handle(post({ text: 'hi' }), crypto.randomUUID(), 'summary')).status).toBe(404);
    expect((await ep.handle(post({ text: 'hi' }), s.agentId, 'nope')).status).toBe(404);
    await sql`update app.services set status = 'off' where agent_id = ${s.agentId}`;
    expect((await ep.handle(post({ text: 'hi' }), s.agentId, 'summary')).status).toBe(404);
    await sql`update app.services set status = 'live' where agent_id = ${s.agentId}`;
    await sql`update app.agents set status = 'provisioning' where id = ${s.agentId}`;
    const r = await ep.handle(post({ text: 'hi' }), s.agentId, 'summary');
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([404, '*']);
    // A revoked agent sells nothing, paid call or probe: specs.service() would still return its live service.
    await sql`update app.agents set status = 'revoked' where id = ${s.agentId}`;
    expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(404);
    expect((await ep.handle(post({ text: 'hi' }), s.agentId, 'summary')).status).toBe(404);
    expect([factoryCalls, x.verified, x.settled]).toEqual([[], 0, 0]);
  });

  it('validates the input before any payment, on the probe and on the paid call alike', async () => {
    const s = await seller();
    const { ep, x, secretsOpened } = endpoint(s);
    expect(await (await ep.handle(post('{nope'), s.agentId, 'summary')).json()).toEqual({ error: 'bad_json' });
    expect(await (await ep.handle(post({ wrong: 1 }), s.agentId, 'summary')).json()).toEqual({ error: 'bad_input', path: '$.text' });
    const big = await ep.handle(post({ text: 'x'.repeat(70_000) }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(big.status).toBe(413);
    expect([x.verified, x.settled, secretsOpened.n]).toEqual([0, 0, 0]);
  });

  it('refuses a hire chain that already paid this agent (508) or a malformed one (400), before the 402 and before any payment', async () => {
    const s = await seller();
    const { ep, x, secretsOpened, runCalls } = endpoint(s);
    const loop = encodeDelegation({ v: 1, root: 'r1', depth: 2, payees: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', s.address] });
    const probe = await ep.handle(post({ text: 'hi' }, { [DELEGATION_HEADER]: loop }), s.agentId, 'summary');
    const paid = await ep.handle(post({ text: 'hi' }, { [DELEGATION_HEADER]: loop, 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([probe.status, paid.status]).toEqual([508, 508]);
    expect(await paid.json()).toEqual({ error: 'delegation_loop' });
    const deep = encodeDelegation({ v: 1, root: 'r1', depth: DELEGATION_MAX_DEPTH + 1, payees: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] });
    expect(await (await ep.handle(post({ text: 'hi' }, { [DELEGATION_HEADER]: deep }), s.agentId, 'summary')).json()).toEqual({ error: 'max_depth' });
    expect((await ep.handle(post({ text: 'hi' }, { [DELEGATION_HEADER]: 'nope' }), s.agentId, 'summary')).status).toBe(400);
    expect([x.verified, x.settled, secretsOpened.n, runCalls.length]).toEqual([0, 0, 0, 0]);
    // A valid chain without this agent goes on to the usual 402.
    const ok = encodeDelegation({ v: 1, root: 'r1', depth: 1, payees: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] });
    expect((await ep.handle(post({ text: 'hi' }, { [DELEGATION_HEADER]: ok }), s.agentId, 'summary')).status).toBe(402);
  });

  it('answers the unpaid probe with 402 PAYMENT-REQUIRED from the cached x402 server, without opening the key', async () => {
    const s = await seller();
    const { ep, factoryCalls, secretsOpened } = endpoint(s);
    for (let i = 0; i < 2; i++) {
      const r = await ep.handle(post({ text: 'hi' }), s.agentId, 'summary');
      expect(r.status).toBe(402);
      expect(r.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
      expect(r.headers.get('access-control-expose-headers')).toContain('PAYMENT-REQUIRED');
    }
    expect(factoryCalls).toEqual(['0.01']);
    expect(secretsOpened.n).toBe(0);
    expect(ep.resourceUrl(s.agentId, 'summary')).toBe(`${BASE}/a/${s.agentId}/summary`);
  });

  it('a paid call: output, PAYMENT-RESPONSE and a record that verifies (identity included); the run is settled', async () => {
    const s = await seller();
    const { ep, x, settledRuns, runCalls } = endpoint(s);
    const r = await ep.handle(post({ text: 'Stellar' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(r.status).toBe(200);
    expect(await r.clone().json()).toEqual({ summary: 'got Stellar' });
    expect(r.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    const record = decodeRecordHeader(r.headers.get(ENACTMENT_HEADER)!);
    expect(record.agent).toEqual({ chain: 'stellar', address: s.address, agentId: '77' });
    expect(record.settlement).toMatchObject({ ref: TX, amount: '0.0100000', asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' });
    const v = await verifyRecord(record, settlementAdapter(s.address));
    expect(v.checks).toEqual({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' });
    expect(x.settled).toBe(1);
    expect(runCalls.map((c) => c.userId)).toEqual([s.userId]); // the owner comes from the agent's row, never from the request
    expect(settledRuns.map(([, tx, earned]) => [tx, earned])).toEqual([[TX, '0.0100000']]);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('a service run with skills signs a v0.2 record naming them; it verifies like any other', async () => {
    const s = await seller();
    const skills = [{ id: 'acme/skills/digest', sha256: 'c'.repeat(64) }];
    const { ep } = endpoint(s, { runService: async () => ({ runId: crypto.randomUUID(), output: { summary: 'ok' }, skills }) });
    const r = await ep.handle(post({ text: 'Stellar' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(r.status).toBe(200);
    const record = decodeRecordHeader(r.headers.get(ENACTMENT_HEADER)!);
    expect(record.v).toBe('0.2');
    expect((record as { skills?: unknown }).skills).toEqual(skills);
    expect((await verifyRecord(record, settlementAdapter(s.address))).checks).toEqual({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' });
  });

  it('the same paid call over MCP: PaymentRequired first, then output, settlement and a record that verifies, through this endpoint', async () => {
    const s = await seller();
    const paid = { x402Version: 2, accepted: (await fakeX402(s.address).accepts())[0], payload: { transaction: 'AAAA' } };
    const header = encodePaymentSignatureHeader(paid as never);
    const base = fakeX402(s.address);
    const verify = base.verify.bind(base);
    // The fake facilitator accepts 'good'; the MCP route sends the encoded payload, so map that one to it.
    const x = Object.assign(base, { verify: async (h: string) => verify(h === header ? 'good' : h) });
    const { ep, settledRuns } = endpoint(s, { x });
    const mcp = createServiceMcp({ agent: async () => ({ name: 'Seller', status: 'active' }), specs: createSpecs(sql), endpoint: ep, version: '1' });
    const call = async (meta?: Record<string, unknown>) => {
      const r = await mcp.handle(new Request(`${BASE}/a/${s.agentId}/mcp`, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summary', arguments: { text: 'Stellar' }, ...(meta ? { _meta: meta } : {}) } }),
      }), s.agentId);
      return ((await r.json()) as { result: Record<string, unknown> }).result;
    };
    expect(await call()).toMatchObject({ isError: true, structuredContent: { x402Version: 2, accepts: [{ payTo: s.address }] } });
    expect(x.settled).toBe(0);
    const r = await call({ 'x402/payment': paid });
    expect(r).toMatchObject({ structuredContent: { summary: 'got Stellar' }, _meta: { 'x402/payment-response': { transaction: TX } } });
    const record = (r._meta as Record<string, unknown>)['agentenact/record'] as EnactmentRecord;
    expect((await verifyRecord(record, settlementAdapter(s.address))).ok).toBe(true);
    expect(record.input.sha256).toBe(await sha256Hex('{"text":"Stellar"}'));
    expect([x.settled, settledRuns.length]).toEqual([1, 1]);
  });

  it('X fails → nothing settled: the service throws', async () => {
    const s = await seller();
    const { ep, x, settledRuns } = endpoint(s, { runService: async () => Promise.reject(Object.assign(new Error('service: bad_output'), { code: 'bad_output' })) });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, await r.json()]).toEqual([500, { error: 'handler_failed' }]);
    expect([x.settled, settledRuns.length]).toEqual([0, 0]);
  });

  it('X fails → nothing settled: our 30 s abort fires before the library 60 s timeout', async () => {
    const s = await seller();
    let sawAbort = false;
    const slow: ServiceRunner = (_svc, _u, _i, signal) =>
      new Promise((_r, reject) => signal.addEventListener('abort', () => ((sawAbort = true), reject(new Error('service: stopped')))));
    const { ep, x } = endpoint(s, { runService: slow, serviceTimeoutMs: 50, handlerTimeoutMs: 2_000 });
    const t0 = Date.now();
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, sawAbort, x.settled]).toEqual([500, true, 0]);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('our abort stops the service even after a library 504', async () => {
    const s = await seller();
    let sawAbort = false;
    const slow: ServiceRunner = (_svc, _u, _i, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => ((sawAbort = true), reject(new Error('stopped')))));
    const { ep, x } = endpoint(s, { runService: slow, serviceTimeoutMs: 5_000, handlerTimeoutMs: 50 });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, x.settled]).toEqual([504, 0]);
    await Bun.sleep(20);
    expect(sawAbort).toBe(true);
  });

  it('a failed settlement discards the output: 402, nothing recorded', async () => {
    const s = await seller();
    const x = fakeX402(s.address, { settle: async () => ({ ok: false as const, reason: 'settlement_failed' }) });
    const { ep, settledRuns } = endpoint(s, { x });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, await r.json(), settledRuns.length]).toEqual([402, { error: 'settlement_failed' }, 0]);
  });

  it('a post-settle failure still carries PAYMENT-RESPONSE, and the run is still settled', async () => {
    const s = await seller();
    // The vault is down after settle: the record cannot be signed, the settlement still goes back.
    const { ep, x, settledRuns } = endpoint(s, { keys: { publicKey: (id) => keys.publicKey(id), recordSigner: () => async () => Promise.reject(new Error('vault down')) } });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'record_failed', transaction: TX });
    expect(r.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    expect([x.settled, settledRuns.length]).toEqual([1, 1]);
  });

  it('one payment signature runs once: a concurrent copy gets 409 before verify, key and slot; the entry clears when the call ends', async () => {
    const s = await seller();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    const { ep, x, secretsOpened, runCalls, settledRuns } = endpoint(s, { runService: async (svc, userId) => (runCalls.push({ svcId: svc.id, userId }), entered(), await gate, { runId: crypto.randomUUID(), output: { summary: 'ok' } }) });
    const first = ep.handle(post({ text: 'a' }, { 'PAYMENT-SIGNATURE': 'good-sig-1' }), s.agentId, 'summary');
    await inHandler;
    const dup = await ep.handle(post({ text: 'a' }, { 'PAYMENT-SIGNATURE': 'good-sig-1' }), s.agentId, 'summary');
    expect([dup.status, await dup.json()]).toEqual([409, { error: 'payment_in_flight' }]);
    // The key is not touched while the call is in its handler: the vault signs the record only after settle.
    expect([x.verified, secretsOpened.n, runCalls.length]).toEqual([1, 0, 1]);
    release();
    expect((await first).status).toBe(200);
    expect([x.settled, settledRuns.length]).toEqual([1, 1]);
    // the set is empty again: a different signature proceeds (the fake settles it as the same TX, so clear the vault's record row)
    await sql`delete from keyvault.signatures where kind = 'record'`;
    const other = await ep.handle(post({ text: 'b' }, { 'PAYMENT-SIGNATURE': 'good-sig-2' }), s.agentId, 'summary');
    expect(other.status).toBe(200);
  });

  it('the in-flight entry is released when the call fails, so an honest retry of the same signature is not blocked', async () => {
    const s = await seller();
    let fail = true;
    const { ep } = endpoint(s, { runService: async () => (fail ? Promise.reject(new Error('boom')) : { runId: crypto.randomUUID(), output: { summary: 'ok' } }) });
    const h = { 'PAYMENT-SIGNATURE': 'good-sig-retry' };
    expect((await ep.handle(post({ text: 'a' }, h), s.agentId, 'summary')).status).toBe(500);
    fail = false;
    expect((await ep.handle(post({ text: 'a' }, h), s.agentId, 'summary')).status).toBe(200);
  });

  it('caps concurrent paid calls before payment, and refuses under the kill switch', async () => {
    const s = await seller();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    const { ep, x } = endpoint(s, { maxConcurrent: 1, runService: async () => (entered(), await gate, { runId: crypto.randomUUID(), output: { summary: 'ok' } }) });
    const first = ep.handle(post({ text: 'a' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    await inHandler; // deterministic: the first call is inside its handler, holding the only slot
    const second = await ep.handle(post({ text: 'b' }, { 'PAYMENT-SIGNATURE': 'good-2' }), s.agentId, 'summary');
    expect([second.status, await second.json()]).toEqual([503, { error: 'busy' }]);
    expect(x.verified).toBe(1);
    release();
    expect((await first).status).toBe(200);
    const killed = endpoint(s, { killed: true });
    expect((await killed.ep.handle(post({ text: 'a' }), s.agentId, 'summary')).status).toBe(503);
  });

  it('a key that cannot be opened is 503 before any payment', async () => {
    const s = await seller();
    await keys.destroy(s.agentId);
    const events: Record<string, string | number>[] = [];
    const { ep, x } = endpoint(s, { log: (e) => void events.push(e) });
    const r = await ep.handle(post({ text: 'a' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, await r.json(), x.verified, x.settled]).toEqual([503, { error: 'unavailable' }, 0, 0]);
    expect(events.find((e) => e.event === 'service_unavailable')).toMatchObject({ errName: expect.any(String) }); // why is named, not the message
  });

  it('drain: a call still in its handler is aborted before settlement; a call in settlement is awaited and completes; new paid calls get 503', async () => {
    const s = await seller();
    let settleEntered!: () => void;
    const inSettle = new Promise<void>((r) => (settleEntered = r));
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((r) => (releaseSettle = r));
    let slowEntered!: () => void;
    const inHandler = new Promise<void>((r) => (slowEntered = r));
    const x = fakeX402(s.address, {
      settle: async () => {
        x.settled++;
        settleEntered();
        await settleGate;
        return { ok: true as const, transaction: TX, payer: PAYER, amount: '0.0100000', responseHeader: encodePaymentResponseHeader({ success: true, transaction: TX, network: 'stellar:testnet', payer: PAYER }) };
      },
    });
    const runService: ServiceRunner = (_svc, _u, input, signal) =>
      (input as { text: string }).text === 'slow'
        ? new Promise((_r, reject) => (slowEntered(), signal.addEventListener('abort', () => reject(new Error('service: stopped')))))
        : Promise.resolve({ runId: crypto.randomUUID(), output: { summary: 'ok' } });
    const { ep, settledRuns } = endpoint(s, { x, runService });

    const settling = ep.handle(post({ text: 'fast' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    await inSettle;
    const slow = ep.handle(post({ text: 'slow' }, { 'PAYMENT-SIGNATURE': 'good-2' }), s.agentId, 'summary');
    await inHandler;
    expect(ep.inflight().length).toBe(2);

    ep.drain();
    const aborted = await slow;
    expect([aborted.status, await aborted.json(), x.settled]).toEqual([500, { error: 'handler_failed' }, 1]); // only the call in settlement ever settled
    const late = await ep.handle(post({ text: 'late' }, { 'PAYMENT-SIGNATURE': 'good-3' }), s.agentId, 'summary');
    expect([late.status, await late.json()]).toEqual([503, { error: 'busy' }]);
    expect(ep.inflight().length).toBe(1);

    releaseSettle();
    const done = await settling;
    expect([done.status, !!done.headers.get('PAYMENT-RESPONSE'), !!done.headers.get(ENACTMENT_HEADER)]).toEqual([200, true, true]);
    await Promise.all(ep.inflight());
    expect([settledRuns.length, ep.inflight().length]).toEqual([1, 0]);
  });
  it('X fails → nothing settled: a service error with a secret-looking message never reaches the buyer', async () => {
    const s = await seller();
    const { ep, x } = endpoint(s, { runService: async () => Promise.reject(new Error('relation "app.runs" does not exist; password=hunter2')) });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    const text = await r.text();
    expect([r.status, text, x.settled]).toEqual([500, '{"error":"handler_failed"}', 0]);
  });

  it('a malformed price (the DB check makes it unreachable today) is refused before any payment', async () => {
    const s = await seller();
    const real = createSpecs(sql);
    for (const bad of ['0.0000000', '0.00000001', 'abc']) {
      const specs = { service: async (a: string, slug: string) => ({ ...(await real.service(a, slug))!, priceUsdc: bad }) };
      const { ep, x } = endpoint(s, { specs });
      const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
      expect([r.status, x.verified, x.settled]).toEqual([503, 0, 0]);
    }
  });

  it('post-settle failures never escape: runs.settle throwing, returning false, and a throwing logger still return the paid 200', async () => {
    const s = await seller();
    for (const settle of [async () => Promise.reject(new Error('db down')), async () => false]) {
      await sql`delete from keyvault.signatures where kind = 'record'`; // the fake settles both rounds as the same TX
      const { ep, x } = endpoint(s, { runs: { settle: settle as () => Promise<boolean> }, log: () => { throw new Error('log down'); } });
      const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
      expect([r.status, !!r.headers.get('PAYMENT-RESPONSE'), !!r.headers.get(ENACTMENT_HEADER), x.settled]).toEqual([200, true, true, 1]);
    }
  });

  it('a paid call stores the record it returned, linked to the run', async () => {
    const s = await seller();
    const records = createRecords(sql);
    const runId = crypto.randomUUID();
    const { ep } = endpoint(s, { records, runService: async () => ({ runId, output: { summary: 'ok' } }) });
    await sql`insert into app.runs (id, agent_id, mode, status) values (${runId}, ${s.agentId}, 'service', 'running')`;
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(r.status).toBe(200);
    const header = decodeRecordHeader(r.headers.get(ENACTMENT_HEADER)!);
    expect(await records.get(s.agentId, TX)).toEqual(header);
    const row = ((await sql`select run_id from app.records where tx_hash = ${TX}`) as { run_id: string }[])[0]!;
    expect(row.run_id).toBe(runId);
  });

  it('a throwing records.save still returns the paid response with PAYMENT-RESPONSE', async () => {
    const s = await seller();
    const events: Record<string, string | number>[] = [];
    const { ep, x, settledRuns } = endpoint(s, { records: { save: async () => Promise.reject(new Error('db down')) }, log: (e) => void events.push(e) });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, !!r.headers.get('PAYMENT-RESPONSE'), !!r.headers.get(ENACTMENT_HEADER), x.settled, settledRuns.length]).toEqual([200, true, true, 1, 1]);
    expect(await r.json()).toEqual({ summary: 'got hi' });
    expect(events.find((e) => e.event === 'record_store_failed')).toMatchObject({ service: expect.any(String), run: expect.any(String) });
  });

  it('a slow records.save does not delay the response past 2 s, even with a slow runs.settle beside it', async () => {
    const s = await seller();
    const never = new Promise<never>(() => {});
    const events: Record<string, string | number>[] = [];
    const { ep } = endpoint(s, { records: { save: () => never }, runs: { settle: () => never }, log: (e) => void events.push(e) });
    const t0 = Date.now();
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    const took = Date.now() - t0;
    expect([r.status, !!r.headers.get('PAYMENT-RESPONSE')]).toEqual([200, true]);
    expect(took).toBeLessThan(3_000); // one shared 2 s bound, not 2 + 2
    expect(events.map((e) => e.event)).toContain('record_store_timeout');
  });

  it('a failed call (nothing settled) stores nothing', async () => {
    const s = await seller();
    const saved: unknown[] = [];
    const failing = { save: async (...a: unknown[]) => (saved.push(a), true) };
    // the service throws, a bad signature, and a failed settlement: no record may be saved for any of them
    const a = endpoint(s, { records: failing, runService: async () => Promise.reject(new Error('boom')) });
    expect((await a.ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(500);
    const b = endpoint(s, { records: failing });
    expect((await b.ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'bad' }), s.agentId, 'summary')).status).toBe(402);
    const x = fakeX402(s.address, { settle: async () => ({ ok: false as const, reason: 'settlement_failed' }) });
    const c = endpoint(s, { records: failing, x });
    expect((await c.ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(402);
    expect(saved).toEqual([]);
  });

  it('a library throw during settlement (transport error) is 502 settlement_unknown, logged with the run id', async () => {
    const s = await seller();
    const x = fakeX402(s.address, { settle: async () => Promise.reject(new Error('facilitator socket hang up')) });
    const events: Record<string, string | number>[] = [];
    const { ep, settledRuns } = endpoint(s, { x, log: (e) => void events.push(e) });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, await r.json(), settledRuns.length]).toEqual([502, { error: 'settlement_unknown' }, 0]);
    expect(events.find((e) => e.event === 'settlement_unknown')?.run).toBeTruthy();
    // The cause is named (class + checked code), never the message.
    expect(events.find((e) => e.event === 'settlement_unknown')).toMatchObject({ errName: 'Error' });
    expect(JSON.stringify(events)).not.toContain('socket hang up');
  });

  describe('settlement whose answer was lost', () => {
    const lost = (message = 'Facilitator settle failed (500): the relayer gave up at https://secret.example') => Promise.reject(new Error(message));

    it('the payment found on chain: the buyer gets the output, the record and the settlement', async () => {
      const s = await seller();
      const x = fakeX402(s.address, { settle: async () => lost() });
      const asked: { payer: string; payTo: string; units: string }[] = [];
      const events: Record<string, string | number>[] = [];
      const { ep, settledRuns } = endpoint(s, { x, log: (e) => void events.push(e), findSettlement: async (o) => (asked.push({ payer: o.payer, payTo: o.payTo, units: o.units }), TX) });
      const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ summary: 'got hi' });
      expect(asked).toEqual([{ payer: PAYER, payTo: s.address, units: '100000' }]);
      expect(decodePaymentResponseHeader(r.headers.get('PAYMENT-RESPONSE')!)).toMatchObject({ success: true, transaction: TX, network: 'stellar:testnet', payer: PAYER });
      const record = decodeRecordHeader(r.headers.get(ENACTMENT_HEADER)!) as EnactmentRecord;
      expect(record.settlement.ref).toBe(TX);
      expect(settledRuns.map((x) => x[1])).toEqual([TX]);
      expect(events.find((e) => e.event === 'settlement_recovered')).toMatchObject({ tx: TX, errStatus: 500 });
      expect(events.find((e) => e.event === 'settlement_unknown')).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain('secret.example');
    });

    it('not found: 502 settlement_unknown, with the facilitator status and never its words', async () => {
      const s = await seller();
      const x = fakeX402(s.address, { settle: async () => lost() });
      const events: Record<string, string | number>[] = [];
      const { ep, settledRuns } = endpoint(s, { x, log: (e) => void events.push(e), findSettlement: async () => null });
      const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
      expect([r.status, await r.json(), settledRuns.length]).toEqual([502, { error: 'settlement_unknown' }, 0]);
      expect(events.find((e) => e.event === 'settlement_unknown')).toMatchObject({ errName: 'Error', errStatus: 500 });
      expect(JSON.stringify(events)).not.toContain('secret.example');
    });

    it('a lookup that throws is the same as not found', async () => {
      const s = await seller();
      const x = fakeX402(s.address, { settle: async () => lost() });
      const { ep } = endpoint(s, { x, findSettlement: async () => Promise.reject(new Error('horizon down')) });
      expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(502);
    });

    it('a settlement the facilitator refused is not looked for: the buyer was not charged', async () => {
      const s = await seller();
      let looked = 0;
      const x = fakeX402(s.address, { settle: async () => ({ ok: false as const, reason: 'invalid_exact_stellar_payload' }) });
      const { ep } = endpoint(s, { x, findSettlement: async () => (looked++, TX) });
      expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(402);
      expect(looked).toBe(0);
    });

    it('a handler failure never reaches settlement or the lookup', async () => {
      const s = await seller();
      let looked = 0;
      const { ep, x } = endpoint(s, { runService: async () => Promise.reject(new Error('capped')), findSettlement: async () => (looked++, TX) });
      expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(500);
      expect([x.settled, looked]).toEqual([0, 0]);
    });
  });

  it('a settle throw with a library code logs that code', async () => {
    const s = await seller();
    const x = fakeX402(s.address, { settle: async () => Promise.reject(Object.assign(new Error('read ECONNRESET at 10.1.2.3'), { code: 'ECONNRESET' })) });
    const events: Record<string, string | number>[] = [];
    const { ep } = endpoint(s, { x, log: (e) => void events.push(e) });
    await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect(events.find((e) => e.event === 'settlement_unknown')).toMatchObject({ errName: 'Error', errCode: 'ECONNRESET' });
    expect(JSON.stringify(events)).not.toContain('10.1.2.3');
  });

  it('drain before the call arrives: 503 busy, nothing verified or settled', async () => {
    const s = await seller();
    const { ep, x } = endpoint(s);
    ep.drain();
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, x.verified, x.settled]).toEqual([503, 0, 0]);
  });

  it('a throwing paymentRequired on the unpaid probe is 503 payments_unavailable, never an escaped error', async () => {
    const s = await seller();
    const x = fakeX402(s.address, { paymentRequired: async () => Promise.reject(new Error('x402 down')) });
    const { ep } = endpoint(s, { x });
    const r = await ep.handle(post({ text: 'hi' }), s.agentId, 'summary');
    expect([r.status, await r.json()]).toEqual([503, { error: 'payments_unavailable' }]);
  });

  it('drain while a call is in verify: a runner that ignores the signal is never run and nothing settles', async () => {
    const s = await seller();
    let verifyEntered!: () => void;
    const inVerify = new Promise<void>((r) => (verifyEntered = r));
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((r) => (releaseVerify = r));
    const base = fakeX402(s.address);
    const x = fakeX402(s.address, {
      verify: async (h: string) => {
        verifyEntered();
        await verifyGate;
        return base.verify(h);
      },
    });
    let ran = 0;
    const { ep, settledRuns } = endpoint(s, { x, runService: async () => (ran++, { runId: crypto.randomUUID(), output: { summary: 'ok' } }) });
    const call = ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    await inVerify;
    ep.drain();
    releaseVerify();
    const r = await call;
    expect([r.status, ran, x.settled, settledRuns.length]).toEqual([500, 0, 0, 0]);
  });

  it('a hanging runs.settle is bounded: the paid 200 with PAYMENT-RESPONSE still returns, and the timeout is logged with the run id', async () => {
    const s = await seller();
    const events: Record<string, string | number>[] = [];
    const { ep } = endpoint(s, { runs: { settle: () => new Promise<boolean>(() => {}) }, log: (e) => void events.push(e) });
    const t0 = Date.now();
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, !!r.headers.get('PAYMENT-RESPONSE')]).toEqual([200, true]);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(events.find((e) => e.event === 'settlement_record_timeout')?.run).toBeTruthy();
  });

  it('the paid endpoint answers 404 for a service of a paused agent, probe and paid call alike: nothing verified or settled; a resume sells again', async () => {
    const s = await seller();
    const { ep, x, factoryCalls, runCalls } = endpoint(s);
    await sql`update app.agents set status = 'paused' where id = ${s.agentId}`;
    expect((await ep.handle(post({ text: 'hi' }), s.agentId, 'summary')).status).toBe(404);
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([404, '*']);
    expect([factoryCalls, x.verified, x.settled, runCalls.length]).toEqual([[], 0, 0, 0]);
    await sql`update app.agents set status = 'active' where id = ${s.agentId}`;
    expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary')).status).toBe(200);
  });

  it('paused while a paid call is in verify: the service runner refuses before the run and before settlement (nothing settled, no run)', async () => {
    const s = await seller();
    let verifyEntered!: () => void;
    const inVerify = new Promise<void>((r) => (verifyEntered = r));
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((r) => (releaseVerify = r));
    const base = fakeX402(s.address);
    const x = fakeX402(s.address, { verify: async (h: string) => (verifyEntered(), await verifyGate, base.verify(h)) });
    let ran = 0;
    // The real service runner: its agentActive check is the one that runs inside the handler, before settle.
    const runService = createServiceRunner({
      runner: { run: async () => (ran++, Promise.reject(new Error('unreachable'))) },
      toolbox: { serviceTools: (): ToolSet => ({}) },
      agentActive: async (id) => ((await sql`select 1 from app.agents where id = ${id} and status = 'active'`) as unknown[]).length > 0,
    });
    const { ep, settledRuns } = endpoint(s, { x, runService });
    const call = ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    await inVerify;
    await sql`update app.agents set status = 'paused' where id = ${s.agentId}`;
    releaseVerify();
    const r = await call;
    expect([r.status, ran, x.settled, settledRuns.length]).toEqual([500, 0, 0, 0]);
    expect(r.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });

  it('paused after the service run started: the call the buyer already authorized completes and settles (decision; a refusal after the run would waste paid work, and after settle is forbidden)', async () => {
    const s = await seller();
    const runService: ServiceRunner = async () => {
      await sql`update app.agents set status = 'paused' where id = ${s.agentId}`;
      return { runId: crypto.randomUUID(), output: { summary: 'ok' } };
    };
    const { ep, x, settledRuns } = endpoint(s, { runService });
    const r = await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good' }), s.agentId, 'summary');
    expect([r.status, !!r.headers.get('PAYMENT-RESPONSE'), x.settled, settledRuns.length]).toEqual([200, true, 1, 1]);
    // The next call, after the pause, is refused before payment.
    expect((await ep.handle(post({ text: 'hi' }, { 'PAYMENT-SIGNATURE': 'good-2' }), s.agentId, 'summary')).status).toBe(404);
  });
});
