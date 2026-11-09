import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import type { ChainTransfer } from '../src/chain/horizon.js';
import { createKarmaPaymentsReader, type KarmaPaymentsReader } from '../src/chain/karma.js';
import { pollKarmaPayments } from '../src/karma-payments.js';
import { freshDb } from './support/db.js';
import { OWNER, PAYER, USDC, WALLET, jsonResponse, queueFetch } from './support/fake-chain.js';

const SPONSOR = Keypair.random().publicKey();
const CFG = { usdc: USDC, sponsors: [SPONSOR] };
const H = (c: string) => c.repeat(64);
const BASE = 'https://karma.example';

/** A leg in the shape AgentKarma serves (amount a 7-decimal string, optional fields present). */
const leg = (o: Partial<{ id: string; txHash: string; from: string; to: string; amount: string; timestamp: string; success: boolean }> = {}) => ({
  id: '100:0',
  txHash: H('a'),
  from: PAYER,
  to: WALLET,
  amount: '0.0010000',
  timestamp: '2026-10-12T10:00:00Z',
  success: true,
  ...o,
});

describe('createKarmaPaymentsReader', () => {
  it('maps legs to transfers with our asset and integer units, and passes the cursor', async () => {
    const { fetch, urls } = queueFetch([jsonResponse({ payments: [leg({ id: '7:2', amount: '1.5' })], cursor: 'c1', done: true })]);
    const r = createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch });
    const page = await r.page('c0', 500);
    expect(urls[0]).toBe(`${BASE}/api/v2/payments/stellar-testnet?limit=500&cursor=c0`);
    expect(page).toEqual({
      transfers: [{ opId: '7', idx: 2, txHash: H('a'), from: PAYER, to: WALLET, amountUnits: 15_000_000n, asset: USDC, at: '2026-10-12T10:00:00.000Z' }],
      cursor: 'c1',
      done: true,
      dropped: 0,
    });
  });

  it('skips failed and zero legs, drops and counts malformed ones', async () => {
    const { fetch } = queueFetch([
      jsonResponse({
        payments: [leg({ success: false }), leg({ amount: '0' }), leg({ amount: '1.12345678' }), leg({ id: 'x' }), { id: '1:0' }, leg({ id: '9:0' })],
        cursor: 'c2',
        done: false,
      }),
    ]);
    const page = await createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch }).page(null, 10);
    expect(page.transfers.map((t) => t.opId)).toEqual(['9']);
    expect(page.dropped).toBe(3);
    expect(page.done).toBe(false);
  });

  it('keeps the cursor on an empty page and throws on a non-empty page without one', async () => {
    const empty = queueFetch([jsonResponse({ payments: [], cursor: null, done: true })]);
    expect((await createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch: empty.fetch }).page('c5', 10)).cursor).toBe('c5');
    const bad = queueFetch([jsonResponse({ payments: [leg()], cursor: null, done: true })]);
    await expect(createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch: bad.fetch }).page(null, 10)).rejects.toThrow('without cursor');
  });

  it('throws on an unexpected body or a 4xx', async () => {
    const shape = queueFetch([jsonResponse({ rows: [] })]);
    await expect(createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch: shape.fetch }).page(null, 10)).rejects.toThrow('unexpected shape');
    const notFound = queueFetch([jsonResponse({ error: 'no' }, 404)]);
    await expect(createKarmaPaymentsReader({ baseUrl: BASE, usdc: USDC, fetch: notFound.fetch, retry: { tries: 1 } }).page(null, 10)).rejects.toThrow();
  });
});

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});
const reset = async () => {
  for (const t of ['agents', 'feed', 'payments', 'meta']) await db.sql.unsafe(`delete from discovery.${t}`);
};
const addAgent = async (id: number, o: { owner?: string; wallet?: string | null } = {}) => {
  await db.sql`
    insert into discovery.agents (agent_id, owner, wallet, source, next_poll_at)
    values (${id}, ${o.owner ?? OWNER}, ${o.wallet === undefined ? WALLET : o.wallet}, 'event', ${new Date('2026-10-12T11:00:00Z')})`;
};
const tr = (o: Partial<ChainTransfer> & { opId: string }): ChainTransfer => ({
  idx: 0,
  txHash: H('a'),
  from: PAYER,
  to: WALLET,
  amountUnits: 10000n,
  asset: USDC,
  at: '2026-10-12T10:00:00.000Z',
  ...o,
});
type Page = { transfers: ChainTransfer[]; cursor: string | null; done: boolean; dropped?: number } | Error;
function fakeKarma(pages: Page[]) {
  const calls: Array<string | null> = [];
  const r: KarmaPaymentsReader & { calls: typeof calls } = {
    calls,
    async page(cursor) {
      calls.push(cursor);
      const next = pages.shift();
      if (!next) return { transfers: [], cursor, done: true, dropped: 0 };
      if (next instanceof Error) throw next;
      return { dropped: 0, ...next };
    },
  };
  return r;
}
let clock = Date.parse('2026-10-12T12:00:00Z');
/** Each run gets a fresh clock minute so the 30 s spacing never skips a run unless a test asks for it. */
const run = (karma: KarmaPaymentsReader, extra: Partial<Parameters<typeof pollKarmaPayments>[0]> = {}) => {
  clock += 60_000;
  const t = new Date(clock);
  return pollKarmaPayments({ sql: db.sql, karma, cfg: CFG, now: () => t, ...extra });
};
const payments = async () => (await db.sql`select * from discovery.payments order by op_id, idx`) as any[];
const meta = async (key: string) => ((await db.sql`select value from discovery.meta where key = ${key}`) as any[])[0]?.value ?? null;

describe('pollKarmaPayments', () => {
  it('stores a counted payment and its feed line, and saves the cursor', async () => {
    await reset();
    await addAgent(1);
    const res = await run(fakeKarma([{ transfers: [tr({ opId: '100', txHash: H('b') })], cursor: 'c1', done: true }]));
    expect(res).toEqual({ polled: 1, inserted: 1, failed: 0 });
    expect((await payments())[0]).toMatchObject({ op_id: '100', idx: 0, agent_id: 1, tx_hash: H('b'), payer: PAYER, payee: WALLET, amount_units: '10000', counted: true, excluded_reason: null });
    const feed: any[] = await db.sql`select * from discovery.feed`;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'paid', agent_id: 1, source_key: 'pay:100:0' });
    expect(await meta('karma_payments_cursor')).toBe('c1');
  });

  it('applies our own rules: owner, self and sponsor rows are stored uncounted with no feed line', async () => {
    await reset();
    await addAgent(1);
    await run(fakeKarma([{ transfers: [tr({ opId: '1', from: OWNER }), tr({ opId: '2', from: WALLET }), tr({ opId: '3', from: SPONSOR })], cursor: 'c', done: true }]));
    expect((await payments()).map((p) => [p.op_id, p.counted, p.excluded_reason])).toEqual([
      ['1', false, 'owner'],
      ['2', false, 'self'],
      ['3', false, 'sponsor'],
    ]);
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(0);
  });

  it('credits the lowest agent_id of a shared wallet, names the paying agent, and skips unknown payees', async () => {
    await reset();
    const payerWallet = Keypair.random().publicKey();
    await addAgent(2);
    await addAgent(1);
    await addAgent(5, { wallet: payerWallet });
    const log: Array<Record<string, string | number>> = [];
    const res = await run(fakeKarma([{ transfers: [tr({ opId: '1', from: payerWallet }), tr({ opId: '2', to: Keypair.random().publicKey() })], cursor: 'c', done: true }]), { log: (e) => log.push(e) });
    expect(res.inserted).toBe(1);
    expect((await payments())[0]).toMatchObject({ agent_id: 1, payer_agent_id: 5 });
    expect(log).toContainEqual({ event: 'karma_payments_unknown_payee', rows: 1 });
  });

  it('is idempotent, and does not double-count a leg already stored under our own leg numbering', async () => {
    await reset();
    await addAgent(1);
    await run(fakeKarma([{ transfers: [tr({ opId: '1' })], cursor: 'c1', done: true }]));
    // Same operation, same parties and amount, another index: the Horizon decoder's row for the same leg.
    await db.sql`insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payee, amount_units, asset, at, counted)
                 values ('2', 1, 1, ${H('a')}, ${PAYER}, ${WALLET}, 5000, ${USDC}, now(), true)`;
    const res = await run(fakeKarma([{ transfers: [tr({ opId: '1' }), tr({ opId: '2', idx: 0, amountUnits: 5000n })], cursor: 'c2', done: true }]));
    expect(res.inserted).toBe(0);
    expect(await payments()).toHaveLength(2);
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(1);
  });

  it('resumes from the stored cursor and reads pages until done, at most 5 per run', async () => {
    await reset();
    await addAgent(1);
    await run(fakeKarma([{ transfers: [], cursor: 'c0', done: true }]));
    const pages: Page[] = Array.from({ length: 7 }, (_, i) => ({ transfers: [tr({ opId: String(10 + i) })], cursor: `p${i}`, done: false }));
    const karma = fakeKarma(pages);
    const res = await run(karma);
    expect(karma.calls).toEqual(['c0', 'p0', 'p1', 'p2', 'p3']);
    expect(res).toEqual({ polled: 5, inserted: 5, failed: 0 });
    expect(await meta('karma_payments_cursor')).toBe('p4');
  });

  it('reports a failed read so the tick is not OK, keeping the cursor', async () => {
    await reset();
    await addAgent(1);
    await run(fakeKarma([{ transfers: [], cursor: 'c0', done: true }]));
    const log: Array<Record<string, string | number>> = [];
    const res = await run(fakeKarma([new Error('boom https://secret')]), { log: (e) => log.push(e) });
    expect(res).toEqual({ polled: 1, inserted: 0, failed: 1 });
    expect(log).toEqual([{ event: 'karma_payments_failed' }]);
    expect(await meta('karma_payments_cursor')).toBe('c0');
  });

  it('runs at most once per 30 s, and re-reads from the start once a day', async () => {
    await reset();
    await addAgent(1);
    const t0 = Date.parse('2026-10-20T00:00:00Z');
    const at = (ms: number) => () => new Date(t0 + ms);
    await pollKarmaPayments({ sql: db.sql, karma: fakeKarma([{ transfers: [], cursor: 'c9', done: true }]), cfg: CFG, now: at(0) });
    const soon = fakeKarma([]);
    expect(await pollKarmaPayments({ sql: db.sql, karma: soon, cfg: CFG, now: at(10_000) })).toEqual({ polled: 0, inserted: 0, failed: 0 });
    expect(soon.calls).toEqual([]);
    const later = fakeKarma([]);
    await pollKarmaPayments({ sql: db.sql, karma: later, cfg: CFG, now: at(40_000) });
    expect(later.calls).toEqual(['c9']);
    const nextDay = fakeKarma([]);
    await pollKarmaPayments({ sql: db.sql, karma: nextDay, cfg: CFG, now: at(24 * 3600 * 1000 + 1) });
    expect(nextDay.calls).toEqual([null]);
  });
});
