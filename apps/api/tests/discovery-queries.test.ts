import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import type { KarmaFacts, KarmaPayment } from '../src/discovery/karma.js';
import { createDiscovery, formatUsdc } from '../src/discovery/queries.js';
import { likePattern } from '../src/discovery/text.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const G = (c: string) => `G${c.repeat(55)}`;
const NOW = new Date('2026-10-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const tx = () => (++n).toString(16).padStart(64, '0');
const UUID = '11111111-1111-4111-8111-111111111111';

describe('discovery text', () => {
  it('likePattern rejects empty and over-long input', () => {
    expect(likePattern('')).toBeNull();
    expect(likePattern('   ')).toBeNull();
    expect(likePattern('x'.repeat(65))).toBeNull();
    expect(likePattern('x'.repeat(64))).toBe(`%${'x'.repeat(64)}%`);
    expect(likePattern('  A%b_c\\ ')).toBe('%a\\%b\\_c\\\\%');
  });
});

describe('discovery queries', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  // AgentKarma stand-in: per-agent facts and payment lists, switchable to "unavailable".
  let kAvailable = true;
  let kById = new Map<number, KarmaFacts>();
  let kPays = new Map<number, KarmaPayment[] | null | 'fail'>();
  const KARMA_AS_OF = ago(2 * MIN);
  const karma = {
    view: () => ({ available: kAvailable, asOf: KARMA_AS_OF, facts: (id: number) => (kAvailable ? (kById.get(id) ?? null) : null) }),
    payments: async (id: number) => {
      const v = kPays.get(id);
      if (v === 'fail') throw new Error('karma 503');
      return v === undefined ? [] : v;
    },
  };
  const facts = (o: Partial<KarmaFacts> = {}): KarmaFacts => ({ paymentsReceived: 0, usdcReceived: '0', lastPaymentAt: null, score: null, tier: null, ...o });
  const kpay = (txHash: string, amount: string, at: string, idx = 0): KarmaPayment => ({ id: `${txHash.slice(0, 8)}:${idx}`, at, amount, payer: G('P'), txHash });
  const d = (o: Partial<Parameters<typeof createDiscovery>[1]> = {}) => createDiscovery(sql, { now: () => NOW, karma, ...o });

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  beforeEach(async () => {
    kAvailable = true;
    kById = new Map();
    kPays = new Map();
    await sql`truncate discovery.meta, discovery.agents, discovery.registry_events, discovery.payments, discovery.proven_sales, discovery.selfpub, discovery.services, discovery.hidden, discovery.feed restart identity`;
  });

  const agent = (id: number, o: { owner?: string; wallet?: string | null; builder?: string; lastActive?: string | null; uuid?: string | null; regTx?: string | null } = {}) =>
    sql`insert into discovery.agents (agent_id, owner, wallet, source, builder, last_active_at, hosted_uuid, registered_tx, registered_at)
        values (${id}, ${o.owner ?? G(String.fromCharCode(65 + (id % 20)))}, ${o.wallet === undefined ? null : o.wallet}, 'event', ${o.builder ?? 'external'},
                ${o.lastActive ?? null}, ${o.uuid ?? null}, ${o.regTx ?? null}, ${ago(5 * HOUR)})`;
  const pay = (agentId: number, units: number, o: { at?: string; counted?: boolean; payerAgent?: number | null; tx?: string; payer?: string } = {}) => {
    const t = o.tx ?? tx();
    return sql`insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payer_agent_id, payee, amount_units, asset, at, counted, excluded_reason)
      values (${'op' + t}, 0, ${agentId}, ${t}, ${o.payer ?? G('P')}, ${o.payerAgent ?? null}, ${G('W')}, ${units}, 'USDC:X', ${o.at ?? ago(MIN)}, ${o.counted ?? true}, ${o.counted === false ? 'owner' : null})`;
  };
  const sale = (agentId: number, txh: string, units = 10_000, at = ago(MIN), source: 'hosted' | 'submitted' = 'hosted') =>
    sql`insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at)
        values (${txh}, ${G('S')}, ${agentId}, ${'d' + txh}, ${{ secret: 'x' }}, ${source}, ${G('P')}, ${units}, 'USDC:X', ${at})`;
  const selfpub = (id: number, name: string | null, description: string | null, fetchedAt = ago(MIN)) =>
    sql`insert into discovery.selfpub (agent_id, name, description, fetched_at) values (${id}, ${name}, ${description}, ${fetchedAt})`;
  const service = (id: number, slug: string, description: string | null = null, price: string | null = null, url: string | null = null) =>
    sql`insert into discovery.services (agent_id, slug, description, price_usdc, url, first_seen_at, last_seen_at) values (${id}, ${slug}, ${description}, ${price}, ${url}, ${ago(HOUR)}, ${ago(MIN)})`;
  const feedRow = (kind: string, agentId: number, o: { at?: string; txh?: string | null; label?: string | null; units?: number | null; selfPub?: boolean; other?: number | null } = {}) =>
    sql`insert into discovery.feed (kind, agent_id, other_agent_id, amount_units, label, tx_hash, at, self_published, source_key)
        values (${kind}, ${agentId}, ${o.other ?? null}, ${o.units ?? null}, ${o.label ?? null}, ${o.txh === undefined ? null : o.txh}, ${o.at ?? ago(MIN)}, ${o.selfPub ?? false}, ${'k' + ++n})`;

  describe('stats', () => {
    it('counts agents, proven sales and counted usdc only', async () => {
      await agent(1);
      await agent(2);
      await pay(1, 10_000);
      await pay(1, 5_000_000, { counted: false });
      await sale(1, tx());
      const s = await d().stats();
      expect(s).toMatchObject({ network: 'testnet', agents: 2, provenOutputs: 1, usdcTransfers: '0.001' });
      expect(s).not.toHaveProperty('usdcPaid');
    });

    it('splits proven usdc (sales) from transfers (counted payments)', async () => {
      await agent(1);
      await pay(1, 10_000);
      await pay(1, 5_000_000, { counted: false });
      await sale(1, tx(), 30_000);
      await sale(1, tx(), 20_000, ago(3 * HOUR));
      const s = await d().stats();
      expect(s.usdcTransfers).toBe('0.001');
      expect(s.usdcProven).toBe('0.005');
      expect((await createDiscovery(sql, { karma, now: () => new Date(NOW.getTime() + 60_000) }).stats()).usdcProven).toBe('0.005');
    });

    it('usdcProven and usdcTransfers are "0" with no rows', async () => {
      const s = await d().stats();
      expect(s.usdcProven).toBe('0');
      expect(s.usdcTransfers).toBe('0');
      expect(s).toMatchObject({ payments: 0, seals: 0 });
    });

    it('registrations and wallet binds do not make an agent active; payments and sales do', async () => {
      for (const id of [1, 2, 3, 4, 5]) await agent(id);
      const ev = (id: number, kind: string) =>
        sql`insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at) values (${'e' + ++n}, ${id}, ${kind}, ${tx()}, 1, ${ago(MIN)})`;
      await ev(1, 'registered');
      await ev(2, 'wallet_bound');
      await ev(3, 'registered');
      await sale(3, tx()); // registered AND sold: active
      await pay(4, 1000, { payerAgent: 5 }); // 4 received, 5 sent
      const s = await d().stats();
      expect(s.activeLastHour).toBe(3); // 3, 4, 5
    });

    it('counts counted payments and every sent seal, of any agent, deleted ones included', async () => {
      await agent(1);
      await pay(1, 1000);
      await pay(1, 2000);
      await pay(1, 5000, { counted: false }); // an owner top-up: not a payment
      const u = await insertUser(sql);
      const live = await insertAgent(sql, u, { status: 'active' });
      const gone = await insertAgent(sql, u, { status: 'active' });
      await sql`update app.agents set status = 'revoked', deleted_at = now() where id = ${gone}`;
      for (const [a, status] of [[live, 'sent'], [live, 'sent'], [gone, 'sent'], [live, 'pending']] as const) {
        const dg = tx();
        await sql`insert into app.check_seals (agent_id, check_at, document, digest, status, tx_hash, sent_at)
                  values (${a}, ${ago(MIN)}, '{}', ${dg}, ${status}, ${status === 'sent' ? dg : null}, ${status === 'sent' ? ago(MIN) : null})`;
      }
      expect(await d().stats()).toMatchObject({ payments: 2, seals: 3, usdcTransfers: '0.0003' });
      await sql`truncate app.check_seals, app.agents, app.users cascade`;
    });

    it('community counts leave out the e2e test accounts and count each transaction once', async () => {
      const seal = async (agentId: string, status = 'sent') => {
        const dg = tx();
        await sql`insert into app.check_seals (agent_id, check_at, document, digest, status, tx_hash, sent_at)
                  values (${agentId}, ${ago(MIN)}, '{}', ${dg}, ${status}, ${status === 'sent' ? dg : null}, ${status === 'sent' ? ago(MIN) : null})`;
        return dg;
      };
      const ev = (id: number, kind: string, txh = tx()) =>
        sql`insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at) values (${'e' + ++n}, ${id}, ${kind}, ${txh}, 1, ${ago(MIN)})`;

      const ada = await insertUser(sql, { email: 'ada@example.com' });
      await insertUser(sql, { email: 'Bob@Example.com' }); // signed in, no agent yet: still a person
      const e2e = await insertUser(sql, { email: 'Kerem+E2E-hire-1@noras.tech' });
      await insertUser(sql, { email: 'kerem+e2e-x@elsewhere.io' }); // not the operator's domain: a person
      await insertAgent(sql, await insertUser(sql, { email: 'kerem+house-xlm-drop@noras.tech' }), { status: 'active' }); // the operator's own agent for hire: counted
      await insertAgent(sql, await insertUser(sql, { email: 'kerem+house@noras.tech' }), { status: 'active' });
      const manual = await insertAgent(sql, await insertUser(sql, { email: 'kerem+test1@noras.tech' }), { status: 'active' }); // the operator's manual account: counted
      await insertAgent(sql, await insertUser(sql, { email: 'Kerem@noras.tech' }), { status: 'active' }); // the operator himself: counted
      await insertUser(sql, { email: 'xkerem@noras.tech' }); // a lookalike is a person
      const live = await insertAgent(sql, ada, { status: 'active' });
      const gone = await insertAgent(sql, ada, { status: 'active' });
      await sql`update app.agents set status = 'revoked', deleted_at = now(), agent_id = '2' where id = ${gone}`;
      await sql`update app.agents set agent_id = '1' where id = ${live}`;
      await insertAgent(sql, ada, { status: 'draft' }); // never created
      const test = await insertAgent(sql, e2e, { status: 'active' });
      await sql`update app.agents set agent_id = '9' where id = ${test}`;

      const shared = await seal(live);
      await seal(live);
      await seal(gone);
      await seal(live, 'pending');
      await seal(test);
      await seal(test);
      await seal(manual); // the operator's own agent: its seals count
      for (const id of [1, 2, 3, 9]) await agent(id);
      await ev(1, 'registered');
      await ev(3, 'registered');
      await ev(9, 'registered');
      await ev(1, 'wallet_bound', shared); // same transaction as a seal: one tx
      await pay(1, 1000, { payerAgent: 3 }); // an outside agent paid ours: ours took part
      await pay(1, 1000, { counted: false }); // an owner top-up is still a transaction
      await pay(3, 1000, { counted: false }); // between agents built elsewhere: the network's, not ours
      await pay(1, 1000, { payerAgent: 9 }); // paid by a test agent
      await pay(9, 1000, { payerAgent: 3 }); // paid to a test agent

      const s = await d().stats();
      expect(s.seals).toBe(6); // the network-wide count is unchanged
      // people: ada, bob, the two lookalikes and the 4 operator accounts; agents add the operator's 4. Only e2e is left out.
      // agents: also live + deleted (draft and test left out).
      // seals: 3 sent of ada's + the operator's 1. txs: 4 seals + agent 1's registration + 2 payments to agent 1; the wallet bind shares a
      // seal's hash. Agent 3 was built elsewhere: its registration and its own top-up are left out.
      expect(s.community).toMatchObject({ people: 8, agents: 6, seals: 4, txs: 7 });
      await sql`truncate app.check_seals, app.agents, app.users cascade`;
    });

    it('community names its newest seal and newest transaction, test accounts left out, so each figure opens a proof', async () => {
      const seal = async (agentId: string, at: string) => {
        const dg = tx();
        await sql`insert into app.check_seals (agent_id, check_at, document, digest, status, tx_hash, sent_at)
                  values (${agentId}, ${at}, '{}', ${dg}, 'sent', ${dg}, ${at})`;
        return dg;
      };
      expect((await d().stats()).community).toMatchObject({ latestSealTx: null, latestTx: null });

      const ada = await insertUser(sql, { email: 'ada@example.com' });
      const e2e = await insertUser(sql, { email: 'kerem+e2e-1@noras.tech' });
      const live = await insertAgent(sql, ada, { status: 'active' });
      await sql`update app.agents set agent_id = '1' where id = ${live}`;
      const test = await insertAgent(sql, e2e, { status: 'active' });
      await sql`update app.agents set agent_id = '9' where id = ${test}`;
      await agent(1);
      await agent(4);
      await agent(9);
      await seal(live, ago(3 * HOUR));
      const newestSeal = await seal(live, ago(2 * HOUR));
      await seal(test, ago(MIN)); // newer, but a test agent's
      const newestPay = tx();
      await pay(1, 1000, { at: ago(HOUR), tx: newestPay });
      await pay(9, 1000, { at: ago(MIN) }); // newer, but to a test agent
      await pay(4, 1000, { at: ago(MIN) }); // newer, but to an agent built elsewhere
      const s = (await d({ cacheMs: 0 }).stats()).community;
      expect(s.latestSealTx).toBe(newestSeal);
      expect(s.latestTx).toBe(newestPay);
      await sql`truncate app.check_seals, app.agents, app.users cascade`;
    });

    it('formats usdc from 7-decimal units', async () => {
      expect((await d().stats()).usdcTransfers).toBe('0');
      expect(formatUsdc(10_000)).toBe('0.001');
      expect(formatUsdc('12345678')).toBe('1.2345678');
      expect(formatUsdc(20_000_000)).toBe('2');
      // never throws: one odd row must not take down the public totals
      expect(formatUsdc(-10_000)).toBe('-0.001');
    });

    it('active means a chain event in the last hour, by chain time', async () => {
      await agent(1);
      await agent(2);
      await agent(3);
      await agent(4);
      await pay(1, 1000, { at: ago(2 * HOUR) }); // ingested now, but 2 h old on chain
      await pay(2, 1000, { at: ago(10 * MIN), payerAgent: 3 }); // receives; agent 3 sent
      const s = await d().stats();
      expect(s.activeLastHour).toBe(2); // agents 2 and 3 only (1 is old, 4 idle)
    });

    it('flags stale when the events heartbeat or the payments tick is old or missing', async () => {
      expect(await d().stats()).toMatchObject({ stale: true, indexedThrough: null });
      await sql`insert into discovery.meta (key, value) values ('heartbeat_at', ${ago(10 * 60_000)})`;
      expect(await d().stats()).toMatchObject({ stale: true, indexedThrough: ago(10 * 60_000) });
      await sql`update discovery.meta set value = ${ago(30_000)} where key = 'heartbeat_at'`;
      expect((await d().stats()).stale).toBe(true); // events are fresh but payments never reported
      await sql`insert into discovery.meta (key, value) values ('payments_ok_at', ${ago(10 * 60_000)})`;
      expect(await d().stats()).toMatchObject({ stale: true, indexedThrough: ago(10 * 60_000) }); // a Horizon outage: the oldest wins
      await sql`update discovery.meta set value = ${ago(20_000)} where key = 'payments_ok_at'`;
      expect(await d().stats()).toMatchObject({ stale: false, indexedThrough: ago(30_000) });
    });

    it('is stale while the indexer is halted, however fresh the ticks look', async () => {
      await sql`insert into discovery.meta (key, value) values ('heartbeat_at', ${ago(10_000)}), ('payments_ok_at', ${ago(10_000)})`;
      expect((await d().stats()).stale).toBe(false);
      await sql`insert into discovery.meta (key, value) values ('halted', 'chain_reset')`;
      expect((await d({ cacheMs: 0 }).stats()).stale).toBe(true);
    });

    it('serves a cached result inside cacheMs', async () => {
      let t = NOW.getTime();
      const disc = createDiscovery(sql, { karma, now: () => new Date(t), cacheMs: 5_000 });
      await agent(1);
      expect((await disc.stats()).agents).toBe(1);
      await agent(2);
      t += 4_000;
      expect((await disc.stats()).agents).toBe(1);
      t += 2_000;
      expect((await disc.stats()).agents).toBe(2);
    });
  });

  describe('feed', () => {
    it('without after returns the newest 50 by chain time', async () => {
      await agent(1);
      for (let i = 0; i < 60; i++) await feedRow('registered', 1, { at: ago((i + 1) * MIN) });
      const r = await d().feed({});
      expect(r.items).toHaveLength(50);
      expect(r.latestSeq).toBe(60);
      expect(r.items[0]!.seq).toBe(1); // youngest chain time was inserted first
      const times = r.items.map((i) => i.at);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('with after returns only newer seq, ascending', async () => {
      await agent(1);
      for (let i = 0; i < 5; i++) await feedRow('registered', 1, { at: ago(i * MIN) });
      const r = await d().feed({ after: 2 });
      expect(r.items.map((i) => i.seq)).toEqual([3, 4, 5]);
      expect(r.latestSeq).toBe(5);
    });

    it('links a paid line to its proof when a proven sale exists, else to the payment', async () => {
      await agent(1, { builder: 'hosted', uuid: UUID });
      await selfpub(1, 'n', 'd');
      const proven = tx();
      const plain = tx();
      await sale(1, proven);
      await feedRow('paid', 1, { txh: proven, units: 10_000, at: ago(MIN) });
      await feedRow('paid', 1, { txh: plain, units: 20_000, at: ago(2 * MIN) });
      await feedRow('registered', 1, { txh: null, at: ago(3 * MIN) });
      await feedRow('registered', 1, { txh: 'abc', at: ago(4 * MIN) });
      const { items } = await d().feed({});
      expect(items[0]).toMatchObject({ amount: '0.001', builder: 'hosted', link: { type: 'proof', ref: proven, agentUuid: UUID } });
      expect(items[1]!.link).toEqual({ type: 'payment', txHash: plain });
      expect(items[2]!.link).toBeNull();
      expect(items[3]!.link).toEqual({ type: 'registration', txHash: 'abc' });
    });

    it('a hidden agent has no service_opened lines', async () => {
      await agent(1);
      await agent(2);
      await feedRow('service_opened', 1, { label: 'shows', selfPub: true });
      await feedRow('service_opened', 2, { label: 'secret', selfPub: true });
      await feedRow('registered', 2, { txh: 'abc' });
      await sql`insert into discovery.hidden (agent_id) values (2)`;
      const { items } = await d().feed({});
      expect(items.filter((i) => i.kind === 'service_opened').map((i) => i.agentId)).toEqual([1]);
      const reg = items.find((i) => i.agentId === 2)!;
      expect(reg).toMatchObject({ kind: 'registered', label: null });
      expect(JSON.stringify(await d().feed({ after: 0 }))).not.toContain('secret');
    });

    it('a backlog over 100 rows is delivered across polls without gaps', async () => {
      await agent(1);
      for (let i = 0; i < 250; i++) await feedRow('registered', 1, { at: ago(i * MIN) });
      const got: number[] = [];
      let after = 0;
      for (let i = 0; i < 10; i++) {
        const r = await d().feed({ after });
        if (r.items.length === 0) break;
        got.push(...r.items.map((x) => x.seq));
        after = r.latestSeq;
      }
      expect(got).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    });

    it('latestSeq never runs ahead of the rows returned', async () => {
      await agent(1);
      for (let i = 0; i < 5; i++) await feedRow('registered', 1);
      const r = await d().feed({ after: 1, limit: 2 });
      expect(r.items.map((x) => x.seq)).toEqual([2, 3]);
      expect(r.latestSeq).toBe(3);
      const none = await d().feed({ after: 5 });
      expect(none).toEqual({ items: [], latestSeq: 5 });
      const empty = await d().feed({ after: 9 });
      expect(empty.latestSeq).toBe(9);
      expect((await d().feed({})).latestSeq).toBe(5); // newest-first mode reports the snapshot max
    });

    it('an external agent with a hosted_uuid claim gets no uuid on its proof link', async () => {
      await agent(1, { builder: 'external', uuid: UUID });
      const t = tx();
      await sale(1, t);
      await feedRow('paid', 1, { txh: t, units: 10_000 });
      const { items } = await d().feed({});
      expect(items[0]!.link).toEqual({ type: 'proof', ref: t, agentUuid: null });
    });

    it('a stale hosted agent gets no uuid on its proof link', async () => {
      await agent(1, { builder: 'hosted', uuid: UUID });
      await selfpub(1, 'a', null, ago(2 * HOUR));
      const t = tx();
      await sale(1, t);
      await feedRow('paid', 1, { txh: t, units: 10_000 });
      expect((await d().feed({})).items[0]!.link).toEqual({ type: 'proof', ref: t, agentUuid: null });
      await sql`update discovery.selfpub set fetched_at = ${ago(MIN)}`;
      expect((await d().feed({})).items[0]!.link).toEqual({ type: 'proof', ref: t, agentUuid: UUID });
    });

    it('a submitted (not hosted) sale gets no uuid even for a hosted agent', async () => {
      await agent(1, { builder: 'hosted', uuid: UUID });
      await selfpub(1, 'a', null);
      const t = tx();
      await sale(1, t, 10_000, ago(MIN), 'submitted');
      await feedRow('paid', 1, { txh: t, units: 10_000 });
      expect((await d().feed({})).items[0]!.link).toEqual({ type: 'proof', ref: t, agentUuid: null });
      expect((await d().profile(1))!.history![0]!.proof).toEqual({ ref: t, agentUuid: null });
    });

    it('clamps limit to 100 and ignores a negative after', async () => {
      await agent(1);
      for (let i = 0; i < 120; i++) await feedRow('registered', 1, { at: ago(i * MIN) });
      expect((await d().feed({ limit: 1000 })).items).toHaveLength(100);
      expect((await d().feed({ after: 0, limit: 1000 })).items).toHaveLength(100);
      const neg = await d().feed({ after: -5, limit: 3 });
      expect(neg.items).toHaveLength(3);
      expect(neg.items[0]!.seq).toBe(1); // newest-first, not ascending-from-after
      expect((await d().feed({ limit: 0 })).items).toHaveLength(1);
    });

    it('a hosted agent whose last verification is older than an hour reads as external', async () => {
      await agent(1, { builder: 'hosted', uuid: UUID });
      await agent(2, { builder: 'hosted', uuid: UUID.replace('1', '2') });
      await agent(3, { builder: 'hosted', uuid: UUID.replace('1', '3') });
      await selfpub(1, 'a', null, ago(2 * HOUR));
      await selfpub(2, 'b', null, ago(30 * MIN));
      for (const id of [1, 2, 3]) await feedRow('registered', id);
      const by = Object.fromEntries((await d().feed({})).items.map((i) => [i.agentId, i.builder]));
      expect(by).toEqual({ 1: 'external', 2: 'hosted', 3: 'external' });
      const cards = Object.fromEntries((await d().agents({})).items.map((c) => [c.id, c.builder]));
      expect(cards).toEqual({ 1: 'external', 2: 'hosted', 3: 'external' });
      expect((await d().profile(1))!.builder).toBe('external');
      expect((await d().profile(2))!.builder).toBe('hosted');
      expect((await d().profile(3))!.builder).toBe('external');
    });
  });

  describe('agents', () => {
    it('returns an empty list for an empty index', async () => {
      expect(await d().agents({})).toEqual({ items: [], next: null, payments: { source: 'agentkarma', available: true, asOf: KARMA_AS_OF } });
    });

    it('orders by last activity with null last, and pages by cursor without gaps or repeats', async () => {
      await agent(1, { lastActive: ago(5 * MIN) });
      await agent(2, { lastActive: ago(1 * MIN) });
      await agent(3, { lastActive: null });
      await agent(4, { lastActive: ago(5 * MIN) }); // ties agent 1: higher id first
      await agent(5, { lastActive: null });
      const seen: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await d().agents({ limit: 2, cursor });
        seen.push(...page.items.map((c) => c.id));
        if (!page.next) break;
        cursor = page.next;
      }
      expect(seen).toEqual([2, 4, 1, 5, 3]);
    });

    it('treats a garbage cursor as the first page', async () => {
      await agent(1, { lastActive: ago(MIN) });
      await agent(2, { lastActive: ago(2 * MIN) });
      for (const c of ['!!!', 'bm9wZQ', Buffer.from('1:99999999999999').toString('base64url'), Buffer.from('x:1').toString('base64url')]) {
        expect((await d().agents({ cursor: c })).items.map((i) => i.id)).toEqual([1, 2]);
      }
    });

    it('card payment totals and score come from AgentKarma; proven sales stay ours', async () => {
      await agent(1, { lastActive: ago(MIN) });
      await pay(1, 900_000); // our index is not the source of card payments any more
      await sale(1, tx());
      kById.set(1, facts({ paymentsReceived: 2, usdcReceived: '0.003', lastPaymentAt: ago(3 * HOUR), score: 87, tier: 'Very Good' }));
      const r = await d().agents({});
      expect(r.items[0]).toEqual({
        id: 1, builder: 'external', selfPublished: null,
        paymentsReceived: 2, usdcReceived: '0.003', lastPaymentAt: ago(3 * HOUR), provenSales: 1, seals: 0, lastActiveAt: ago(MIN),
        karma: { score: 87, tier: 'Very Good' }, hire: null,
      });
      expect(r.payments).toEqual({ source: 'agentkarma', available: true, asOf: KARMA_AS_OF });
    });

    it('an agent AgentKarma does not list yet has null payment fields and no score', async () => {
      await agent(1, { lastActive: ago(MIN) });
      const [c] = (await d().agents({})).items;
      expect(c).toMatchObject({ paymentsReceived: null, usdcReceived: null, lastPaymentAt: null, karma: null, provenSales: 0 });
    });

    it('when AgentKarma is unavailable, cards keep our data, payment fields are null, and the page says since when', async () => {
      await agent(1, { lastActive: ago(MIN) });
      await selfpub(1, 'Named', 'Turns a repo into a deck.');
      await sale(1, tx());
      kById.set(1, facts({ paymentsReceived: 5 }));
      kAvailable = false;
      const r = await d().agents({});
      expect(r.payments).toEqual({ source: 'agentkarma', available: false, asOf: KARMA_AS_OF });
      expect(r.items[0]).toMatchObject({ id: 1, selfPublished: { name: 'Named', description: 'Turns a repo into a deck.', service: null }, provenSales: 1, paymentsReceived: null, usdcReceived: null, lastPaymentAt: null, karma: null });
    });

    it('finds #46, 46 and the owner prefix', async () => {
      await agent(46, { owner: 'GABCDEFGH' + 'A'.repeat(47), wallet: 'GWALLETXY' + 'B'.repeat(47) });
      await agent(4);
      expect((await d().agents({ q: '#46' })).items.map((i) => i.id)).toEqual([46]);
      expect((await d().agents({ q: '46' })).items.map((i) => i.id)).toEqual([46]);
      expect((await d().agents({ q: 'GABCD' })).items.map((i) => i.id)).toEqual([46]);
      expect((await d().agents({ q: 'gwallet' })).items.map((i) => i.id)).toEqual([46]);
      expect((await d().agents({ q: '99999999999' })).items).toEqual([]);
    });

    it('a name starting with g is still found by text search', async () => {
      await agent(1);
      await agent(2);
      await selfpub(1, 'Gemini helper', 'x');
      await selfpub(2, 'other', 'y');
      expect((await d().agents({ q: 'gemini' })).items.map((i) => i.id)).toEqual([1]);
      // an address-looking prefix still matches the owner as well
      await agent(3, { owner: 'GEMINI' + 'A'.repeat(50) });
      expect((await d().agents({ q: 'gemini' })).items.map((i) => i.id).sort()).toEqual([1, 3]);
      expect((await d().agents({ q: 'g' + 'a'.repeat(60) })).items).toEqual([]);
    });

    it('an external agent profile has no proof uuid, a fresh hosted one does', async () => {
      await agent(1, { builder: 'external', uuid: UUID });
      await agent(2, { builder: 'hosted', uuid: UUID.replace('1', '2') });
      await selfpub(2, 'h', null);
      const a = tx();
      const b = tx();
      await sale(1, a);
      await sale(2, b);
      expect((await d().profile(1))!.history![0]!.proof).toEqual({ ref: a, agentUuid: null });
      expect((await d().profile(2))!.history![0]!.proof).toEqual({ ref: b, agentUuid: UUID.replace('1', '2') });
    });

    it('text search escapes % and _', async () => {
      await agent(1);
      await agent(2);
      await selfpub(1, 'Plain Name', 'does things');
      await selfpub(2, '100% real_deal', null);
      expect((await d().agents({ q: '%' })).items.map((i) => i.id)).toEqual([2]);
      expect((await d().agents({ q: '_' })).items.map((i) => i.id)).toEqual([2]);
      expect((await d().agents({ q: 'e_l' })).items).toEqual([]);
      expect((await d().agents({ q: 'PLAIN' })).items.map((i) => i.id)).toEqual([1]);
      expect((await d().agents({ q: 'x'.repeat(65) })).items).toEqual([]);
    });

    it('searches service slug and description', async () => {
      await agent(1);
      await selfpub(1, 'n', null);
      await service(1, 'translate', 'English to Turkish', '0.01');
      const hit = await d().agents({ q: 'turkish' });
      expect(hit.items[0]!.selfPublished).toEqual({ name: 'n', description: null, service: { slug: 'translate', description: 'English to Turkish', priceUsdc: '0.01' } });
      expect((await d().agents({ q: 'transl' })).items).toHaveLength(1);
    });

    it('does not search hidden agents text', async () => {
      await agent(1);
      await selfpub(1, 'findable', 'x');
      await service(1, 'findable-svc');
      await sql`insert into discovery.hidden (agent_id) values (1)`;
      expect((await d().agents({ q: 'findable' })).items).toEqual([]);
      const all = (await d().agents({})).items;
      expect(all).toHaveLength(1);
      expect(all[0]!.selfPublished).toBeNull();
      expect((await d().agents({ q: '#1' })).items[0]!.selfPublished).toBeNull();
    });

    describe('sort and filter', () => {
      const ids = async (o: Parameters<ReturnType<typeof d>['agents']>[0]) => (await d().agents(o)).items.map((c) => c.id);
      /** A hosted agent (fresh selfpub) with `n` sealed and one pending check seal. */
      const sealed = async (id: number, n: number) => {
        const u = await insertUser(sql);
        const uuid = await insertAgent(sql, u, { status: 'active' });
        await sql`update discovery.agents set builder = 'hosted', hosted_uuid = ${uuid} where agent_id = ${id}`;
        await selfpub(id, `hosted ${id}`, null);
        for (let i = 0; i < n; i++) {
          const dg = tx();
          await sql`insert into app.check_seals (agent_id, check_at, document, digest, status, tx_hash, sent_at)
                    values (${uuid}, ${ago(MIN)}, '{}', ${dg}, 'sent', ${dg}, ${ago(MIN)})`;
        }
        const dg = tx();
        await sql`insert into app.check_seals (agent_id, check_at, document, digest) values (${uuid}, ${ago(MIN)}, '{}', ${dg})`;
      };

      beforeEach(async () => {
        await sql`truncate app.check_seals, app.agents, app.users cascade`;
        await agent(1, { lastActive: ago(1 * MIN) });
        await agent(2, { lastActive: ago(2 * MIN) });
        await agent(3, { lastActive: ago(3 * MIN) });
        await agent(4, { lastActive: ago(4 * MIN) });
        await agent(5, { lastActive: null });
        kById.set(2, facts({ paymentsReceived: 3, usdcReceived: '0.03', score: 49, tier: 'Fair' }));
        kById.set(3, facts({ paymentsReceived: 21, usdcReceived: '0.21', score: 71, tier: 'Good' }));
        kById.set(4, facts({ paymentsReceived: 1, usdcReceived: '0.21', score: 23, tier: 'Poor' }));
      });

      it('counts only sent seals of a verified hosted agent', async () => {
        await sealed(1, 3);
        await sealed(5, 1);
        const by = Object.fromEntries((await d().agents({})).items.map((c) => [c.id, c.seals]));
        expect(by).toEqual({ 1: 3, 2: 0, 3: 0, 4: 0, 5: 1 });
        // stale verification: reads as external, and the seal count goes with the hosted claim
        await sql`update discovery.selfpub set fetched_at = ${ago(2 * HOUR)} where agent_id = 1`;
        expect((await d().agents({ q: '#1' })).items[0]!.seals).toBe(0);
        await sql`insert into discovery.hidden (agent_id) values (5)`;
        expect((await d().agents({ q: '#5' })).items[0]!.seals).toBe(0);
      });

      it('sorts by usdc, payment count as tie-break, unknown last', async () => {
        expect(await ids({ sort: 'paid' })).toEqual([3, 4, 2, 1, 5]);
        kAvailable = false;
        // nothing known: last activity order stays
        expect(await ids({ sort: 'paid' })).toEqual([1, 2, 3, 4, 5]);
      });

      it('sorts by proofs (proven sales + seals), karma score and newest', async () => {
        await sealed(4, 2);
        await sale(2, tx());
        expect(await ids({ sort: 'proofs' })).toEqual([4, 2, 1, 3, 5]);
        expect(await ids({ sort: 'karma' })).toEqual([3, 2, 4, 1, 5]);
        expect(await ids({ sort: 'newest' })).toEqual([5, 4, 3, 2, 1]);
        expect(await ids({ sort: 'nope' as never })).toEqual([1, 2, 3, 4, 5]);
      });

      it('filters by builder, service and payments, ANDed, with a matched count', async () => {
        await sealed(1, 1);
        await service(3, 'classify');
        await selfpub(3, 'Classifier', null);
        await sale(5, tx());
        expect(await ids({ filter: { built: 'agentenact' } })).toEqual([1]);
        expect(await ids({ filter: { built: 'external' } })).toEqual([2, 3, 4, 5]);
        expect(await ids({ filter: { sells: true } })).toEqual([3]);
        expect(await ids({ filter: { paid: true } })).toEqual([2, 3, 4, 5]);
        const r = await d().agents({ filter: { paid: true, built: 'external' }, sort: 'paid' });
        expect(r.items.map((c) => c.id)).toEqual([3, 4, 2, 5]);
        expect(r.matched).toBe(4);
        expect(await ids({ filter: { built: 'agentenact', paid: true } })).toEqual([]);
        expect((await d().agents({})).matched).toBeUndefined();
      });

      it('for hire: built here with x402 or a price; external only with a priced service url to call', async () => {
        const RUN = 'https://agent.example.org/run';
        await selfpub(1, 'Web only', null);
        await service(1, 'web', null, null, 'https://agent.example.org'); // an endpoint without a price is not for hire
        await selfpub(2, 'Callable', null);
        await service(2, 'free', null, '0', 'https://agent.example.org/free'); // a zero price is not a sale
        await service(2, 'summarise', null, '0.02', RUN);
        await service(2, 'web', null, '0.01', 'https://agent.example.org'); // an endpoint name is never the service to call
        await sql`update discovery.agents set builder = 'library' where agent_id = 3`;
        await selfpub(3, 'Priced', null);
        await service(3, 'b-deck', null, '1');
        await service(3, 'a-logo', null, '0.25');
        await service(3, 'c-web');
        // external, "x402" and a price but nothing to call (a provider manifest names no url): not for hire
        await sql`insert into discovery.selfpub (agent_id, name, description, fetched_at, x402) values (4, 'Says x402', null, ${ago(MIN)}, true)`;
        await service(4, 'stellar-agent-services', null, null, 'https://agent.example.org/.well-known/stellar-agent-services.json');
        await service(4, 'pitch-deck', null, '0.1');
        await sql`insert into discovery.selfpub (agent_id, name, description, fetched_at, x402) values (5, 'Hidden', null, ${ago(MIN)}, true)`;
        await service(5, 'run', null, '0.01', RUN);
        await sql`insert into discovery.hidden (agent_id) values (5)`;
        const r = await d().agents({ filter: { hire: true } });
        expect(r.items.map((c) => [c.id, c.hire])).toEqual([
          [2, { priceUsdc: '0.02', service: { slug: 'summarise', url: RUN } }],
          [3, { priceUsdc: '0.25', service: null }],
        ]);
        expect(r.matched).toBe(2);
        // the card names the cheapest priced service, not the last seen endpoint
        expect(r.items[1]!.selfPublished?.service).toEqual({ slug: 'a-logo', description: null, priceUsdc: '0.25' });
        const all = Object.fromEntries((await d().agents({})).items.map((c) => [c.id, c.hire]));
        expect(all).toEqual({ 1: null, 2: { priceUsdc: '0.02', service: { slug: 'summarise', url: RUN } }, 3: { priceUsdc: '0.25', service: null }, 4: null, 5: null });
        expect(await ids({ filter: { hire: true, paid: true } })).toEqual([2, 3]);
        expect(await ids({ filter: { hire: true, built: 'agentenact' } })).toEqual([3]);
        // built here and saying x402 without a price: for hire, priced when called
        await sql`update discovery.agents set builder = 'library' where agent_id = 4`;
        expect((await d().agents({})).items.find((c) => c.id === 4)!.hire).toEqual({ priceUsdc: '0.1', service: null });
      });

      it('combines with search, and pages by offset without gaps or repeats', async () => {
        expect(await ids({ q: '#3', sort: 'paid' })).toEqual([3]);
        const seen: number[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10; i++) {
          const page = await d().agents({ sort: 'paid', limit: 2, cursor });
          seen.push(...page.items.map((c) => c.id));
          if (!page.next) break;
          cursor = page.next;
        }
        expect(seen).toEqual([3, 4, 2, 1, 5]);
        // a keyset cursor from the default list is not an offset: it starts over
        const keyset = (await d().agents({ limit: 1 })).next!;
        expect(await ids({ sort: 'paid', limit: 1, cursor: keyset })).toEqual([3]);
      });
    });
  });

  describe('profile', () => {
    it('returns null for an unknown id', async () => {
      expect(await d().profile(999)).toBeNull();
      expect(await d().profile(Number.NaN)).toBeNull();
    });

    it('hides the wallet of an unbound agent', async () => {
      await agent(1, { owner: G('A'), wallet: G('A') });
      await agent(2, { owner: G('A'), wallet: G('B') });
      await agent(3, { owner: G('A'), wallet: null });
      expect((await d().profile(1))!.wallet).toBeNull();
      expect((await d().profile(2))!.wallet).toBe(G('B'));
      expect((await d().profile(3))!.wallet).toBeNull();
    });

    it('history is AgentKarma payments (one line per op) with our proof joined by tx, then sales AgentKarma lacks', async () => {
      await agent(1, { builder: 'hosted', uuid: UUID, regTx: 'regtx' });
      await selfpub(1, 'n', 'd');
      const both = tx();
      const multi = tx();
      const onlySale = tx();
      await sale(1, both, 10_000, ago(5 * MIN));
      await sale(1, onlySale, 40_000, ago(20 * MIN));
      kById.set(1, facts({ paymentsReceived: 3, usdcReceived: '1.001', lastPaymentAt: ago(5 * MIN), score: 50, tier: 'Fair' }));
      kPays.set(1, [kpay(both, '0.001', ago(5 * MIN)), kpay(multi, '0.2', ago(10 * MIN), 0), kpay(multi, '0.8', ago(10 * MIN), 1)]);
      const p = (await d().profile(1))!;
      expect(p.registered).toEqual({ at: ago(5 * HOUR), txHash: 'regtx', source: 'event' });
      expect(p.totals).toEqual({ paymentsReceived: 3, usdcReceived: '1.001', provenSales: 2 });
      expect(p.karma).toEqual({ score: 50, tier: 'Fair' });
      expect(p.payments).toEqual({ source: 'agentkarma', available: true, asOf: KARMA_AS_OF });
      expect(p.history!.map((h) => [h.id, h.txHash, h.amount, h.proof?.ref ?? null])).toEqual([
        [`${both.slice(0, 8)}:0`, both, '0.001', both],
        [`${multi.slice(0, 8)}:0`, multi, '0.2', null],
        [`${multi.slice(0, 8)}:1`, multi, '0.8', null],
        [`sale:${onlySale}`, onlySale, '0.004', onlySale],
      ]);
      expect(p.history![0]!.proof).toEqual({ ref: both, agentUuid: UUID });
    });

    it('when AgentKarma fails for the profile, history is null and the payments block says unavailable; our data stays', async () => {
      await agent(1);
      await sale(1, tx());
      kById.set(1, facts({ paymentsReceived: 1, usdcReceived: '0.001' }));
      kPays.set(1, 'fail');
      const p = (await d().profile(1))!;
      expect(p.history).toBeNull();
      expect(p.payments).toEqual({ source: 'agentkarma', available: false, asOf: KARMA_AS_OF });
      expect(p.totals).toEqual({ paymentsReceived: null, usdcReceived: null, provenSales: 1 });
    });

    it('when the AgentKarma snapshot is unavailable, payment totals are null even if the list call works', async () => {
      await agent(1);
      kById.set(1, facts({ paymentsReceived: 1 }));
      kAvailable = false;
      const p = (await d().profile(1))!;
      expect(p.totals.paymentsReceived).toBeNull();
      expect(p.karma).toBeNull();
      expect(p.payments.available).toBe(false);
      expect(p.history).toBeNull();
    });

    it('an agent AgentKarma does not know has only our proven sales as history', async () => {
      await agent(1);
      const s = tx();
      await sale(1, s);
      kPays.set(1, null);
      const p = (await d().profile(1))!;
      expect(p.history!.map((h) => h.txHash)).toEqual([s]);
      expect(p.totals.paymentsReceived).toBeNull();
      expect(p.payments.available).toBe(true);
    });

    it('puts self-published text under selfPublished only, and omits it when hidden', async () => {
      await agent(1);
      await selfpub(1, 'Name', 'Desc');
      await service(1, 'b', 'bd', '0.1');
      await service(1, 'a');
      const p = (await d().profile(1))!;
      expect(p.selfPublished).toEqual({
        name: 'Name',
        description: 'Desc',
        services: [
          { slug: 'a', description: null, priceUsdc: null, url: null },
          { slug: 'b', description: 'bd', priceUsdc: '0.1', url: null },
        ],
        fetchedAt: ago(MIN),
      });
      expect(JSON.stringify({ ...p, selfPublished: null })).not.toContain('Desc');
      await sql`insert into discovery.hidden (agent_id, reason) values (1, 'spam')`;
      const h = (await d().profile(1))!;
      expect(h.selfPublished).toBeNull();
      expect(h.hidden).toBe(true);
      expect(JSON.stringify(h)).not.toMatch(/Name|Desc|spam/);
    });

    it('carries the hire offer and the agent site from its own document', async () => {
      await agent(1);
      await selfpub(1, 'Name', null);
      await service(1, 'web', null, null, 'https://agent.example.org');
      await service(1, 'run', 'Runs', '0.03', 'https://agent.example.org/run');
      const p = (await d().profile(1))!;
      expect(p.hire).toEqual({ priceUsdc: '0.03', service: { slug: 'run', url: 'https://agent.example.org/run' } });
      expect(p.site).toBe('https://agent.example.org');
      await agent(2);
      await selfpub(2, 'Talker', null);
      await service(2, 'web', null, null, 'https://talker.example.org');
      expect((await d().profile(2))!).toMatchObject({ hire: null, site: 'https://talker.example.org' });
      await sql`insert into discovery.hidden (agent_id) values (1)`;
      expect((await d().profile(1))!).toMatchObject({ hire: null, site: null });
    });

    it('returns the karma link built from the owner', async () => {
      await agent(1, { owner: G('K') });
      expect((await d().profile(1))!.links.karma).toBe(`https://agentkarma.io/agent/${G('K')}`);
    });

    it('never returns the verified record body', async () => {
      await agent(1);
      await sale(1, tx());
      expect(JSON.stringify(await d().profile(1))).not.toContain('secret');
    });
  });
});

describe('discovery schema guards', () => {
  it('proven_sales refuses a non-positive amount', async () => {
    const { freshDb } = await import('./support/db.js');
    const { sql, drop } = await freshDb();
    try {
      await expect(
        Promise.resolve(sql`insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at)
          values (${'a'.repeat(64)}, 'GX', 1, 'd0', '{}'::jsonb, 'submitted', 'GP', 0, 'USDC:GX', now())`),
      ).rejects.toMatchObject({ errno: '23514' });
    } finally {
      await drop();
    }
  });
});
