import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { signRecord, type ChainAdapter, type EnactmentRecord, type Settlement, type UnsignedEnactmentRecord, type VerifyResult, verifyRecord } from 'agentenact';
import { createStellarAdapter, stellarSecretToBytes } from 'agentenact/adapters/stellar';
import { Keypair } from '@stellar/stellar-sdk';
import type { Db } from '../src/db/index.js';
import { createIntake, verifierFor } from '../src/discovery/intake.js';
import { createApp } from '../src/gateway/app.js';
import { SUBMISSIONS_PER_HOUR, SUBMISSIONS_PER_IP_PER_HOUR } from '../src/gateway/discovery.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';

const API = 'https://api.agentenact.io';
const USDC = TESTNET.usdc;
const AGENT_ID = 31;
const hex = (c: string) => c.repeat(64);
const real = createStellarAdapter({ network: 'testnet' }); // sign/verify only; nothing here touches the network
const key = Keypair.random(); // throwaway
const payer = Keypair.random().publicKey();

let nonceN = 0;
const nonce = () => (++nonceN).toString(16).padStart(32, '0');
let refN = 0;
const ref = () => (++refN).toString(16).padStart(64, 'a');
const SETTLED_AT = '2026-10-12T10:00:00.000Z';

function unsigned(o: { ref?: string; asset?: string; agentId?: string | null; amount?: string; nonce?: string } = {}): UnsignedEnactmentRecord {
  return {
    v: '0.1',
    agent: { chain: 'stellar', address: key.publicKey(), ...(o.agentId === null ? {} : { agentId: o.agentId ?? String(AGENT_ID) }) },
    input: { sha256: hex('1') },
    output: { sha256: hex('2'), mediaType: 'text/plain', bytes: 12 },
    settlement: { chain: 'stellar', ref: o.ref ?? ref(), payer, amount: o.amount ?? '0.001', asset: o.asset ?? USDC },
    issuedAt: '2026-10-12T10:00:05.000Z',
    nonce: o.nonce ?? nonce(),
  };
}
const sign = (u: UnsignedEnactmentRecord) => signRecord(u, real, stellarSecretToBytes(key.secret()));

/** Real signature and timing/identity logic over a chain fake with realistic Settlement and binding shapes. */
function chainFake(o: { missing?: boolean; unbound?: boolean } = {}): ChainAdapter {
  return {
    ...real,
    readSettlement: async (r): Promise<Settlement[]> =>
      o.missing ? [] : [{ chain: 'stellar', ref: r, payer, payee: key.publicKey(), amount: '0.0010000', asset: USDC, at: SETTLED_AT }],
    resolveIdentity: async () => (o.unbound ? null : { owner: Keypair.random().publicKey(), wallet: key.publicKey() }),
  };
}
const verifyWith = (a: ChainAdapter) => (r: unknown): Promise<VerifyResult> => verifyRecord(r, a);

describe('discovery intake', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let calls = 0;
  const logs: Record<string, unknown>[] = [];
  const intake = (o: { verify?: (r: unknown) => Promise<VerifyResult>; maxConcurrent?: number } = {}) =>
    createIntake({ sql, usdc: USDC, log: (e) => void logs.push(e), ...(o.maxConcurrent ? { maxConcurrent: o.maxConcurrent } : {}),
      verifier: { signature: verifierFor(real).signature, full: (r) => ((calls++), (o.verify ?? verifyWith(chainFake()))(r)) } });
  const rows = async () => ({
    subs: (await sql`select digest, record from discovery.submissions`) as { digest: string; record: Record<string, unknown> }[],
    sales: (await sql`select 1 from discovery.proven_sales`).length,
  });

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  beforeEach(async () => {
    calls = 0;
    logs.length = 0;
    await sql`truncate discovery.agents, discovery.submissions, discovery.proven_sales`;
    await sql`insert into discovery.agents (agent_id, owner, source) values (${AGENT_ID}, ${key.publicKey()}, 'event')`;
  });

  it('accepts a record that verifies and stores it once, normalized', async () => {
    const rec = await sign(unsigned());
    const r = await intake().submit({ ...rec, extra: 'junk', agent: { ...rec.agent, evil: 1 } });
    expect(r.status).toBe('accepted');
    const { subs, sales } = await rows();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.record).toEqual(JSON.parse(JSON.stringify(rec)));
    expect(JSON.stringify(subs[0]!.record)).not.toContain('junk');
    expect(sales).toBe(0); // accepted is not counted: the indexer verifies it itself
  });

  it('refuses a forged signature with not_verified and check signature, storing nothing', async () => {
    const rec = await sign(unsigned());
    const forged: EnactmentRecord = { ...rec, output: { ...rec.output, sha256: hex('3') } };
    expect(await intake().submit(forged)).toEqual({ status: 'refused', code: 'not_verified', check: 'signature' });
    expect((await rows()).subs).toHaveLength(0);
  });

  it('refuses a record whose settlement is not found, check settlement', async () => {
    const rec = await sign(unsigned());
    expect(await intake({ verify: verifyWith(chainFake({ missing: true })) }).submit(rec)).toEqual({ status: 'refused', code: 'not_verified', check: 'settlement' });
  });

  it('refuses a record whose identity is not bound, check identity', async () => {
    const rec = await sign(unsigned());
    expect(await intake({ verify: verifyWith(chainFake({ unbound: true })) }).submit(rec)).toEqual({ status: 'refused', code: 'not_verified', check: 'identity' });
  });

  it('refuses a non-USDC asset (bare symbol or foreign issuer) and a record without agentId, before any chain call', async () => {
    const i = intake();
    for (const asset of ['USDC', `USDC:${Keypair.random().publicKey()}`, 'XLM']) {
      expect([asset, await i.submit(await sign(unsigned({ asset })))]).toEqual([asset, { status: 'refused', code: 'wrong_asset' }]);
    }
    expect(await i.submit(await sign(unsigned({ agentId: null })))).toEqual({ status: 'refused', code: 'no_agent_id' });
    expect(calls).toBe(0);
  });

  it('refuses non-positive or odd amounts as malformed, before any chain call', async () => {
    const i = intake();
    for (const amount of ['0', '0.0000000', '-1', '1e3', '0x10', '1.12345678', '9'.repeat(19)]) {
      expect([amount, await i.submit(await sign(unsigned({ amount })))]).toEqual([amount, { status: 'refused', code: 'malformed' }]);
    }
    expect(calls).toBe(0);
  });

  it('refuses garbage and non-stellar chains as malformed', async () => {
    const i = intake();
    for (const raw of [null, 5, 'x', [], {}, { v: '0.1' }]) expect(await i.submit(raw)).toEqual({ status: 'refused', code: 'malformed' });
    const evm = { ...(await sign(unsigned())), settlement: { ...unsigned().settlement, chain: 'celo' } };
    expect(await i.submit(evm)).toEqual({ status: 'refused', code: 'malformed' });
    expect(calls).toBe(0);
  });

  it('refuses a valid record for an agent the index does not hold yet, with retry-after', async () => {
    const rec = await sign(unsigned({ agentId: '999' }));
    expect(await intake().submit(rec)).toEqual({ status: 'refused', code: 'agent_not_indexed' });
    expect((await rows()).subs).toHaveLength(0);
    const res = await appWith(intake()).post(rec);
    expect([res.status, res.headers.get('retry-after')]).toEqual([409, '30']);
  });

  it('the same record twice gives already_received; a new nonce for the same settlement is stored but proves nothing', async () => {
    const i = intake();
    const settlementRef = ref();
    const a = await sign(unsigned({ ref: settlementRef }));
    const b = await sign(unsigned({ ref: settlementRef })); // fresh nonce, same settlement
    const first = await i.submit(a);
    expect(first.status).toBe('accepted');
    expect(await i.submit(a)).toEqual({ status: 'already_received', digest: (first as { digest: string }).digest });
    expect((await i.submit(b)).status).toBe('accepted');
    const { subs, sales } = await rows();
    expect(subs).toHaveLength(2);
    expect(sales).toBe(0);
  });

  it('caps concurrency at 4: the fifth gets busy without a chain call, and the slots free again', async () => {
    const gates: (() => void)[] = [];
    const ok: VerifyResult = { ok: true, checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' } };
    const i = intake({ verify: () => new Promise<VerifyResult>((res) => gates.push(() => res(ok))) });
    const recs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sign(unsigned())));
    const first4 = recs.slice(0, 4).map((r) => i.submit(r));
    while (gates.length < 4) await Bun.sleep(1);
    expect(await i.submit(recs[4]!)).toEqual({ status: 'refused', code: 'busy' });
    expect(calls).toBe(4);
    gates.forEach((g) => g());
    expect((await Promise.all(first4)).map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    const again = i.submit(recs[5]!);
    while (gates.length < 5) await Bun.sleep(1);
    gates[4]!();
    expect((await again).status).toBe('accepted');
  });

  it('a thrown verify gives chain_unavailable and the log has a fixed code, no error text', async () => {
    const i = intake({ verify: async () => { throw new Error('secret-detail-xyz https://horizon-testnet.stellar.org/boom'); } });
    expect(await i.submit(await sign(unsigned()))).toEqual({ status: 'refused', code: 'chain_unavailable' });
    expect(JSON.stringify(logs)).not.toContain('secret-detail');
    expect(logs).toEqual([{ event: 'intake_chain_unavailable' }]);
    expect((await rows()).subs).toHaveLength(0);
  });

  it('refuses a settlement ref that is not 64 lowercase hex, and agent ids with leading zeros or above u32', async () => {
    const i = intake();
    for (const r of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '/../x', '../'.repeat(30)]) {
      expect([r, await i.submit(await sign(unsigned({ ref: r })))]).toEqual([r, { status: 'refused', code: 'malformed' }]);
    }
    for (const agentId of ['031', '00', '4294967296', '12345678901']) {
      expect([agentId, await i.submit(await sign(unsigned({ agentId })))]).toEqual([agentId, { status: 'refused', code: 'malformed' }]);
    }
    expect(calls).toBe(0);
  });

  it('pins the same testnet USDC CODE:ISSUER as the library', () => {
    const src = readFileSync(require.resolve('agentenact/package.json').replace('package.json', 'src/networks.ts'), 'utf8');
    const lib = /STELLAR_USDC_TESTNET\s*=\s*'([^']+)'/.exec(src)?.[1];
    const pinned: string = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    expect(lib).toBe(pinned);
    expect<string>(TESTNET.usdc).toBe(pinned);
  });

  function appWith(i: ReturnType<typeof intake>) {
    const app = createApp({
      sql: (async () => []) as never, verify: async () => null, passkey: {} as never, signRequests: {} as never, provisioner: {} as never,
      appOrigin: 'https://app.agentenact.io', log: (e) => void logs.push(e),
      discovery: { discovery: {} as never, exportCsv: (async () => ({ csv: '', truncated: false })) as never, intake: i, log: (e) => void logs.push(e) },
    });
    const post = (body: unknown, ip = '203.0.113.9') => app(new Request(`${API}/public/records`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ip);
    return { app, post };
  }

  describe('http', () => {
    it('maps results: 202, 200, 400s, 422 with check, 503s with retry-after', async () => {
      const { post } = appWith(intake());
      const rec = await sign(unsigned());
      const a = await post(rec);
      expect([a.status, (await a.json() as { status: string }).status, a.headers.get('access-control-allow-origin')]).toEqual([202, 'accepted', '*']);
      const b = await post(rec);
      expect([b.status, (await b.json() as { status: string }).status]).toEqual([200, 'already_received']);
      for (const [body, code] of [[{}, 'malformed'], [await sign(unsigned({ agentId: null })), 'no_agent_id'], [await sign(unsigned({ asset: 'USDC' })), 'wrong_asset']] as const) {
        const r = await post(body);
        expect([r.status, await r.json()]).toEqual([400, { error: code }]);
      }
      const forged = { ...rec, nonce: nonce() }; // signature no longer covers it
      const f = await post(forged);
      expect([f.status, await f.json()]).toEqual([422, { error: 'not_verified', check: 'signature' }]);
      const down = appWith(intake({ verify: async () => { throw new Error('x'); } }));
      const d = await down.post(await sign(unsigned()));
      expect([d.status, d.headers.get('retry-after')]).toEqual([503, '60']);
      const gates: (() => void)[] = [];
      const busy = appWith(intake({ maxConcurrent: 1, verify: () => new Promise<VerifyResult>((res) => gates.push(() => res({ ok: false, checks: {} as never, failure: { check: 'settlement', reason: 'not_found' } }))) }));
      const held = busy.post(await sign(unsigned()));
      while (gates.length < 1) await Bun.sleep(1);
      const r = await busy.post(await sign(unsigned()), '203.0.113.50');
      expect([r.status, r.headers.get('retry-after')]).toEqual([503, '5']);
      gates[0]!();
      expect((await held).status).toBe(422);
    });

    it('rate limits an ip after 10 per hour, before reading the body or calling verify', async () => {
      const { post } = appWith(intake());
      for (let n = 0; n < SUBMISSIONS_PER_IP_PER_HOUR; n++) expect((await post(await sign(unsigned()), '198.51.100.7')).status).toBe(202);
      expect(calls).toBe(SUBMISSIONS_PER_IP_PER_HOUR);
      const limited = await post(await sign(unsigned()), '198.51.100.7');
      expect([limited.status, Number(limited.headers.get('retry-after')) > 0]).toEqual([429, true]);
      expect(calls).toBe(SUBMISSIONS_PER_IP_PER_HOUR);
    });

    const ipN = (n: number) => `10.2.${Math.floor(n / 250)}.${n % 250}`;

    it('junk and forged submissions never consume the global budget', async () => {
      const { post } = appWith(intake());
      const other = Keypair.random();
      for (let n = 0; n < 300; n++) {
        const ip = ipN(n);
        let r: Response;
        if (n % 3 === 0) r = await post({}, ip); // malformed
        else if (n % 3 === 1) r = await post(await signRecord(unsigned(), real, stellarSecretToBytes(other.secret())), ip); // signed by a stranger, claims the owner's address
        else r = await post(await signRecord({ ...unsigned(), agent: { chain: 'stellar', address: other.publicKey(), agentId: String(AGENT_ID) } }, real, stellarSecretToBytes(other.secret())), ip); // throwaway key, indexed agent
        expect(r.status).toBe(n % 3 === 0 ? 400 : n % 3 === 1 ? 422 : 409); // forged signature: terminal; unknown signer: maybe index lag
      }
      expect(calls).toBe(0);
      // the global budget is untouched: a valid submission still gets through
      expect((await post(await sign(unsigned()), ipN(1000))).status).toBe(202);
      expect(calls).toBe(1);
    });

    it('an exhausted global budget gives 503 rate_limited with retry-after, before any chain read, and charges only verified-signature records', async () => {
      let charged = 0;
      const { post } = appWith(createIntake({ sql, usdc: USDC, verifier: { signature: verifierFor(real).signature, full: (r) => ((calls++), verifyWith(chainFake())(r)) }, budget: () => (++charged > 2 ? 42 : 0) }));
      expect((await post(await sign(unsigned()), ipN(1))).status).toBe(202);
      expect((await post({}, ipN(2))).status).toBe(400);
      expect((await post(await sign(unsigned()), ipN(3))).status).toBe(202);
      expect(charged).toBe(2);
      const over = await post(await sign(unsigned()), ipN(4));
      expect([over.status, over.headers.get('retry-after'), await over.json()]).toEqual([503, '42', { error: 'rate_limited' }]);
      expect(calls).toBe(2);
    });

    it('a record for an unindexed agent costs no chain read', async () => {
      const { post } = appWith(intake());
      expect((await post(await sign(unsigned({ agentId: '999' })))).status).toBe(409);
      expect(calls).toBe(0);
    });

    it('a record signed by an address that is neither the indexed owner nor wallet is retryable as agent_not_indexed (index lag), no chain read', async () => {
      const ok: VerifyResult = { ok: true, checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' } };
      const i = intake({ verify: async () => ok }); // the chain fake binds a fixed wallet; only the local index rule is under test here
      const stranger = Keypair.random();
      const rec = await signRecord({ ...unsigned(), agent: { chain: 'stellar', address: stranger.publicKey(), agentId: String(AGENT_ID) } }, real, stellarSecretToBytes(stranger.secret()));
      expect(await i.submit(rec)).toEqual({ status: 'refused', code: 'agent_not_indexed' });
      expect(calls).toBe(0);
      // the indexed wallet signs just as well as the owner
      await sql`update discovery.agents set wallet = ${stranger.publicKey()} where agent_id = ${AGENT_ID}`;
      expect((await i.submit(rec)).status).toBe('accepted');
    });

    it('caps one agentId at 20 verifications per hour, charged before the global budget, without starving other agents', async () => {
      let charged = 0;
      const { post } = appWith(createIntake({ sql, usdc: USDC, verifier: { signature: verifierFor(real).signature, full: (r) => ((calls++), verifyWith(chainFake({ missing: true }))(r)) }, budget: () => (++charged, 0) }));
      for (let n = 0; n < 20; n++) {
        const r = await post(await sign(unsigned()), ipN(2000 + n));
        expect([r.status, ((await r.json()) as { check?: string }).check]).toEqual([422, 'settlement']);
      }
      const over = await post(await sign(unsigned()), ipN(2100));
      expect([over.status, Number(over.headers.get('retry-after')) > 0, ((await over.json()) as { error: string }).error]).toEqual([503, true, 'rate_limited']);
      expect([calls, charged]).toEqual([20, 20]);
      // another agent is unaffected
      const other = Keypair.random();
      await sql`insert into discovery.agents (agent_id, owner, source) values (${AGENT_ID + 1}, ${other.publicKey()}, 'event')`;
      const rec = await signRecord({ ...unsigned(), agent: { chain: 'stellar', address: other.publicKey(), agentId: String(AGENT_ID + 1) } }, real, stellarSecretToBytes(other.secret()));
      expect((await post(rec, ipN(2101))).status).toBe(422);
      expect([calls, charged]).toEqual([21, 21]);
    });

    it('a busy refusal consumes neither the global budget nor the per-agent cap', async () => {
      const gates: (() => void)[] = [];
      let charged = 0;
      const i = createIntake({ sql, usdc: USDC, maxConcurrent: 1, budget: () => (++charged, 0),
        verifier: { signature: verifierFor(real).signature, full: () => new Promise<VerifyResult>((res) => gates.push(() => res({ ok: false, checks: {} as never, failure: { check: 'settlement', reason: 'not_found' } }))) } });
      const held = i.submit(await sign(unsigned()));
      while (gates.length < 1) await Bun.sleep(1);
      for (let n = 0; n < 30; n++) expect(await i.submit(await sign(unsigned()))).toEqual({ status: 'refused', code: 'busy' });
      expect(charged).toBe(1);
      gates[0]!();
      await held;
      // 30 busy refusals would have tripped the 20 cap had they been charged
      const next = i.submit(await sign(unsigned()));
      while (gates.length < 2) await Bun.sleep(1);
      gates[1]!();
      expect((await next).status).toBe('refused');
      expect(charged).toBe(2);
    });

    it('a replayed record costs no chain read', async () => {
      const i = intake();
      const rec = await sign(unsigned());
      expect((await i.submit(rec)).status).toBe('accepted');
      expect(calls).toBe(1);
      for (let n = 0; n < 5; n++) expect((await i.submit(rec)).status).toBe('already_received');
      expect(calls).toBe(1);
    });

    it('413 over 8 KB (declared or streamed) and 400 on bad json', async () => {
      const { app, post } = appWith(intake());
      expect((await post('x'.repeat(9000))).status).toBe(413);
      const declared = await app(new Request(`${API}/public/records`, { method: 'POST', body: '{}', headers: { 'content-length': '9000' } }), '203.0.113.2');
      expect(declared.status).toBe(413);
      const streamed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5000)); c.enqueue(new Uint8Array(5000)); c.close(); } });
      expect((await app(new Request(`${API}/public/records`, { method: 'POST', body: streamed, duplex: 'half' } as RequestInit), '203.0.113.3')).status).toBe(413);
      const bad = await post('{nope');
      expect([bad.status, await bad.json()]).toEqual([400, { error: 'bad_json' }]);
      expect(calls).toBe(0);
    });

    it('GET /public/records/:ref returns the verified record and 404s unknown or malformed refs', async () => {
      const { app } = appWith(intake());
      const rec = await sign(unsigned());
      await sql`insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at)
                values (${rec.settlement.ref}, ${key.publicKey()}, ${AGENT_ID}, ${'d'.repeat(64)}, ${rec as unknown as Record<string, unknown>}, 'submitted', ${payer}, 10000, ${USDC}, ${SETTLED_AT})`;
      const ok = await app(new Request(`${API}/public/records/${rec.settlement.ref}`), '203.0.113.4');
      expect([ok.status, ok.headers.get('cache-control'), ok.headers.get('access-control-allow-origin')]).toEqual([200, 'public, max-age=31536000, immutable', '*']);
      expect(await ok.json()).toEqual(JSON.parse(JSON.stringify(rec)));
      for (const p of [hex('f'), 'zz', rec.settlement.ref.toUpperCase(), rec.settlement.ref.slice(1)]) expect([p, (await app(new Request(`${API}/public/records/${p}`), '203.0.113.4')).status]).toEqual([p, 404]);
    });
  });
});
