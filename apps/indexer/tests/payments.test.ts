import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { createHorizonReader, type ChainTransfer, type HorizonReader } from '../src/chain/horizon.js';
import { pollPayments } from '../src/payments.js';
import { freshDb } from './support/db.js';
import {
  LOOKALIKE_ISSUER,
  OWNER,
  PAYER,
  USDC,
  WALLET,
  classicPayment,
  horizonPage,
  jsonResponse,
  queueFetch,
  sorobanTransfer,
  usdcChange,
} from './support/fake-chain.js';

const SPONSOR = Keypair.random().publicKey();
const CFG = { usdc: USDC, sponsors: [SPONSOR] };
const NOW = new Date('2026-10-12T12:00:00Z');
const now = () => NOW;
const H = (c: string) => c.repeat(64);

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});
const reset = async () => {
  for (const t of ['agents', 'feed', 'payments', 'registry_events']) await db.sql.unsafe(`delete from discovery.${t}`);
};
const addAgent = async (id: number, o: { owner?: string; wallet?: string | null; registeredAt?: string | null; cursor?: string | null; lastActive?: string | null } = {}) => {
  await db.sql`
    insert into discovery.agents (agent_id, owner, wallet, source, registered_at, payments_cursor, last_active_at, next_poll_at)
    values (${id}, ${o.owner ?? OWNER}, ${o.wallet === undefined ? WALLET : o.wallet}, 'event', ${o.registeredAt === undefined ? null : o.registeredAt},
            ${o.cursor ?? null}, ${o.lastActive ?? null}, ${new Date('2026-10-12T11:00:00Z')})`;
};

type Pages = Record<string, Array<{ transfers: ChainTransfer[]; cursor: string | null; done: boolean } | Error>>;
/** Scripted reader: per wallet, pages are served in order; records each call. */
function fakeHorizon(pages: Pages) {
  const calls: Array<{ wallet: string; cursor: string | null; limit: number }> = [];
  const r: HorizonReader & { calls: typeof calls } = {
    calls,
    async accountPayments(wallet, cursor, limit) {
      calls.push({ wallet, cursor, limit });
      const next = pages[wallet]?.shift();
      if (!next) return { transfers: [], cursor, done: true };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return r;
}
const tr = (o: Partial<ChainTransfer> & { opId: string }): ChainTransfer => ({
  idx: 0,
  txHash: H('a'),
  from: PAYER,
  to: WALLET,
  amountUnits: 10000n,
  asset: USDC,
  at: '2026-10-12T10:00:00Z',
  ...o,
});
const run = (horizon: HorizonReader, extra: Partial<Parameters<typeof pollPayments>[0]> = {}) => pollPayments({ sql: db.sql, horizon, cfg: CFG, now, ...extra });
const payments = async () => (await db.sql`select * from discovery.payments order by op_id, idx`) as any[];
const agent = async (id: number) => ((await db.sql`select * from discovery.agents where agent_id = ${id}`) as any[])[0];

describe('pollPayments', () => {
  it('stores a counted payment with its tx hash, and a feed line', async () => {
    await reset();
    await addAgent(1);
    const res = await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '100', txHash: H('b') })], cursor: 'c1', done: true }] }));
    expect(res).toEqual({ polled: 1, inserted: 1, failed: 0 });
    const [p] = await payments();
    expect(p).toMatchObject({ op_id: '100', idx: 0, agent_id: 1, tx_hash: H('b'), payer: PAYER, payer_agent_id: null, payee: WALLET, amount_units: '10000', asset: USDC, counted: true, excluded_reason: null });
    const feed: any[] = await db.sql`select * from discovery.feed`;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'paid', agent_id: 1, other_agent_id: null, amount_units: '10000', tx_hash: H('b'), source_key: 'pay:100:0', self_published: false });
    expect(new Date(feed[0].at).toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect((await agent(1)).payments_cursor).toBe('c1');
  });

  it('stores an owner top-up with counted=false and reason owner, and no feed line', async () => {
    await reset();
    await addAgent(1);
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', from: OWNER })], cursor: 'c', done: true }] }));
    const [p] = await payments();
    expect(p).toMatchObject({ counted: false, excluded_reason: 'owner' });
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(0);
    expect((await agent(1)).last_active_at).toBeNull();
  });

  it('stores a sponsor top-up the same way, and other assets and self transfers', async () => {
    await reset();
    await addAgent(1);
    await run(
      fakeHorizon({
        [WALLET]: [
          {
            transfers: [
              tr({ opId: '1', from: SPONSOR }),
              tr({ opId: '2', asset: `USDC:${LOOKALIKE_ISSUER}` }),
              tr({ opId: '3', asset: 'XLM' }),
              tr({ opId: '4', from: WALLET }),
            ],
            cursor: 'c',
            done: true,
          },
        ],
      }),
    );
    expect((await payments()).map((p) => [p.op_id, p.counted, p.excluded_reason])).toEqual([
      ['1', false, 'sponsor'],
      ['2', false, 'asset'],
      ['3', false, 'asset'],
      ['4', false, 'self'],
    ]);
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(0);
  });

  it('ignores transfers out of the wallet', async () => {
    await reset();
    await addAgent(1);
    const other = Keypair.random().publicKey();
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', from: WALLET, to: other })], cursor: 'c', done: true }] }));
    expect(await payments()).toHaveLength(0);
    expect((await agent(1)).payments_cursor).toBe('c');
  });

  it('credits a wallet shared by two agents once, to the lowest agent_id', async () => {
    await reset();
    await addAgent(5);
    await addAgent(3);
    const h = fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' })], cursor: 'c', done: true }] });
    const res = await run(h);
    expect(res.polled).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect((await payments()).map((p) => p.agent_id)).toEqual([3]);
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(1);
  });

  it('an agent with no wallet is never polled', async () => {
    await reset();
    await addAgent(2, { wallet: null });
    const h = fakeHorizon({});
    expect(await run(h)).toEqual({ polled: 0, inserted: 0, failed: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it('a self-owned agent (owner === wallet) is polled; another account counts, a self-transfer does not', async () => {
    await reset();
    await addAgent(1, { owner: WALLET, wallet: WALLET });
    const h = fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' }), tr({ opId: '2', from: WALLET })], cursor: 'c', done: true }] });
    expect(await run(h)).toEqual({ polled: 1, inserted: 2, failed: 0 });
    expect((await payments()).map((p) => [p.op_id, p.counted, p.excluded_reason])).toEqual([
      ['1', true, null],
      ['2', false, 'self'],
    ]);
  });

  it('only polls agents that are due, oldest first, up to maxWallets', async () => {
    await reset();
    const w = [Keypair.random().publicKey(), Keypair.random().publicKey(), Keypair.random().publicKey()];
    for (const [i, wallet] of w.entries()) await addAgent(i + 1, { wallet });
    await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T13:00:00Z')} where agent_id = 1`;
    await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T10:00:00Z')} where agent_id = 3`;
    const h = fakeHorizon({});
    expect((await run(h, { maxWallets: 1 })).polled).toBe(1);
    expect(h.calls.map((c) => c.wallet)).toEqual([w[2]!]);
  });

  it('is idempotent across runs and resumes from the cursor', async () => {
    await reset();
    await addAgent(1);
    const page = { transfers: [tr({ opId: '1' })], cursor: 'c1', done: true };
    await run(fakeHorizon({ [WALLET]: [page] }));
    await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T11:00:00Z')}`;
    const h = fakeHorizon({ [WALLET]: [page] });
    const res = await run(h);
    expect(h.calls[0]!.cursor).toBe('c1');
    expect(res.inserted).toBe(0);
    expect(await payments()).toHaveLength(1);
    expect(await db.sql`select 1 from discovery.feed`).toHaveLength(1);
  });

  it('reads pages until done, saving the cursor per page, and stops at 5 pages per run', async () => {
    await reset();
    await addAgent(1);
    const pages = Array.from({ length: 7 }, (_, i) => ({ transfers: [tr({ opId: String(i + 1) })], cursor: `c${i + 1}`, done: false }));
    const h = fakeHorizon({ [WALLET]: pages });
    const res = await run(h);
    expect(h.calls).toHaveLength(5);
    expect(res.inserted).toBe(5);
    const a = await agent(1);
    expect(a.payments_cursor).toBe('c5');
    // backlog left: come back in 20 s, not 120 s
    expect(new Date(a.next_poll_at).toISOString()).toBe('2026-10-12T12:00:20.000Z');
  });

  it('a 429 storm leaves the cursor untouched and reschedules in 60 s', async () => {
    await reset();
    await addAgent(1, { cursor: 'keep' });
    const q = queueFetch([new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })]);
    const horizon = createHorizonReader({ horizonUrl: 'https://horizon-testnet.stellar.org', fetch: q.fetch, retry: { sleep: async () => {} } });
    const logs: Array<Record<string, string | number>> = [];
    const res = await run(horizon, { log: (e) => logs.push(e) });
    expect(res).toEqual({ polled: 1, inserted: 0, failed: 1 }); // a swallowed Horizon failure is counted, not hidden
    expect(q.urls.length).toBeGreaterThan(1);
    const a = await agent(1);
    expect(a.payments_cursor).toBe('keep');
    expect(new Date(a.next_poll_at).toISOString()).toBe('2026-10-12T12:01:00.000Z');
    expect(logs).toEqual([{ event: 'payments_poll_failed', agent_id: 1 }]);
    expect(await payments()).toHaveLength(0);
  });

  it('keeps pages committed before a later page fails', async () => {
    await reset();
    await addAgent(1);
    const h = fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' })], cursor: 'c1', done: false }, new Error('boom')] });
    await run(h);
    const a = await agent(1);
    expect(a.payments_cursor).toBe('c1');
    expect(await payments()).toHaveLength(1);
    expect(new Date(a.next_poll_at).toISOString()).toBe('2026-10-12T12:01:00.000Z');
  });

  it('links payer_agent_id when the payer is another agent wallet and updates both agents last_active_at', async () => {
    await reset();
    const payerWallet = Keypair.random().publicKey();
    await addAgent(1);
    await addAgent(2, { owner: Keypair.random().publicKey(), wallet: payerWallet });
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', from: payerWallet, at: '2026-10-12T09:30:00Z' })], cursor: 'c', done: true }] }));
    const [p] = await payments();
    expect(p).toMatchObject({ agent_id: 1, payer_agent_id: 2, counted: true });
    const feed: any[] = await db.sql`select * from discovery.feed`;
    expect(feed[0]).toMatchObject({ agent_id: 1, other_agent_id: 2 });
    for (const id of [1, 2]) expect(new Date((await agent(id)).last_active_at).toISOString()).toBe('2026-10-12T09:30:00.000Z');
  });

  it('never moves last_active_at backwards', async () => {
    await reset();
    await addAgent(1, { lastActive: '2026-10-12T11:30:00Z' });
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', at: '2026-10-12T09:00:00Z' })], cursor: 'c', done: true }] }));
    expect(new Date((await agent(1)).last_active_at).toISOString()).toBe('2026-10-12T11:30:00.000Z');
  });

  it('one transaction with two transfers to the wallet gives two rows, one tx hash', async () => {
    await reset();
    await addAgent(1);
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '7', idx: 0, amountUnits: 9000n }), tr({ opId: '7', idx: 1, amountUnits: 1000n })], cursor: 'c', done: true }] }));
    const rows = await payments();
    expect(rows.map((p) => [p.idx, p.amount_units, p.tx_hash])).toEqual([
      [0, '9000', H('a')],
      [1, '1000', H('a')],
    ]);
    expect((await db.sql`select source_key from discovery.feed order by source_key`).map((r: any) => r.source_key)).toEqual(['pay:7:0', 'pay:7:1']);
  });

  it('uses the chain time for last_active_at, not the ingest time', async () => {
    await reset();
    await addAgent(1);
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', at: '2026-09-01T08:15:00Z' })], cursor: 'c', done: true }] }));
    expect(new Date((await agent(1)).last_active_at).toISOString()).toBe('2026-09-01T08:15:00.000Z');
  });

  it('a wallet that rebinds is polled from a null cursor and old rows keep their agent_id', async () => {
    await reset();
    const w2 = Keypair.random().publicKey();
    await addAgent(1);
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' })], cursor: 'c1', done: true }] }));
    // what registry-events does on a wallet change
    await db.sql`update discovery.agents set wallet = ${w2}, payments_cursor = null, next_poll_at = ${new Date('2026-10-12T11:00:00Z')} where agent_id = 1`;
    const h = fakeHorizon({ [w2]: [{ transfers: [tr({ opId: '2', to: w2 })], cursor: 'd1', done: true }] });
    await run(h);
    expect(h.calls).toEqual([{ wallet: w2, cursor: null, limit: 200 }]);
    expect((await payments()).map((p) => [p.op_id, p.agent_id, p.payee])).toEqual([
      ['1', 1, WALLET],
      ['2', 1, w2],
    ]);
  });

  it('schedules 20 s for an agent with recent counted activity or a new registration, else 120 s', async () => {
    await reset();
    const w = [Keypair.random().publicKey(), Keypair.random().publicKey(), Keypair.random().publicKey()];
    await addAgent(1, { wallet: w[0]!, registeredAt: '2026-10-12T00:00:00Z' }); // registered 12 h ago
    await addAgent(2, { wallet: w[1]!, registeredAt: '2026-09-01T00:00:00Z' }); // old, idle
    await addAgent(3, { wallet: w[2]!, registeredAt: '2026-09-01T00:00:00Z' }); // old, paid 2 days ago
    await run(fakeHorizon({ [w[2]!]: [{ transfers: [tr({ opId: '9', to: w[2]!, at: '2026-10-10T12:00:00Z' })], cursor: 'c', done: true }] }));
    const next = async (id: number) => (new Date((await agent(id)).next_poll_at).getTime() - NOW.getTime()) / 1000;
    expect(await next(1)).toBe(20);
    expect(await next(2)).toBe(120);
    expect(await next(3)).toBe(20);
  });

  it('an excluded payment alone does not make an idle agent busy', async () => {
    await reset();
    await addAgent(1, { registeredAt: '2026-09-01T00:00:00Z' });
    await run(fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1', from: OWNER })], cursor: 'c', done: true }] }));
    expect((new Date((await agent(1)).next_poll_at).getTime() - NOW.getTime()) / 1000).toBe(120);
  });
});

describe('pollPayments resilience', () => {
  const bad = (opId: string) => tr({ opId, amountUnits: 0n }); // the DB rejects amount_units <= 0
  const runN = async (n: number, mk: () => HorizonReader, extra: Partial<Parameters<typeof pollPayments>[0]> = {}) => {
    for (let i = 0; i < n; i++) {
      await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T11:00:00Z')}`;
      await run(mk(), extra);
    }
  };

  it('a row the DB rejects does not block later rows: after 3 failures the page is inserted row by row', async () => {
    await reset();
    await addAgent(1);
    const logs: Array<Record<string, string | number>> = [];
    const mk = () => fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' }), bad('2'), tr({ opId: '3' })], cursor: 'c1', done: true }] });
    await runN(3, mk, { log: (e) => logs.push(e) });
    expect(await payments()).toHaveLength(0);
    expect((await agent(1)).payments_cursor).toBeNull();
    expect(logs.filter((l) => l.event === 'payments_poll_failed')).toHaveLength(3);
    await runN(1, mk, { log: (e) => logs.push(e) });
    expect((await payments()).map((p) => p.op_id)).toEqual(['1', '3']);
    expect((await agent(1)).payments_cursor).toBe('c1');
    expect(logs.filter((l) => l.event === 'payment_row_skipped')).toEqual([{ event: 'payment_row_skipped', op_id: '2' }]);
    expect((await db.sql`select source_key from discovery.feed order by source_key`).map((r: any) => r.source_key)).toEqual(['pay:1:0', 'pay:3:0']);
  });

  it('a successful page clears the failure count', async () => {
    await reset();
    await addAgent(1);
    const failing = () => fakeHorizon({ [WALLET]: [{ transfers: [bad('2')], cursor: 'c1', done: true }] });
    await runN(2, failing);
    await runN(1, () => fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' })], cursor: 'c1', done: true }] }));
    expect((await agent(1)).payments_cursor).toBe('c1');
    // a new failure on the same cursor starts from zero again
    await runN(1, () => fakeHorizon({ [WALLET]: [{ transfers: [bad('9')], cursor: 'c2', done: true }] }));
    expect((await agent(1)).payments_cursor).toBe('c1');
  });

  // A Db whose transactions can be told to fail like Postgres does on a lost race. One object for the whole test: the
  // failure counters are keyed by it.
  const flaky = () => {
    const hook = { begin: null as null | (() => void), savepoint: null as null | (() => void) };
    const pgErr = () => Object.assign(new Error('deadlock detected'), { errno: '40P01', code: 'ERR_POSTGRES_SERVER_ERROR' });
    const sqlx = new Proxy(db.sql, {
      get(t, k) {
        if (k === 'begin')
          return (cb: (tx: any) => Promise<unknown>) =>
            (t as any).begin(async (tx: any) => {
              if (hook.begin) {
                hook.begin(); // persistent until the test clears it
              }
              const sp = tx.savepoint.bind(tx);
              return cb(
                new Proxy(tx, {
                  get(tt, kk) {
                    if (kk === 'savepoint')
                      return (f: any) => {
                        if (hook.savepoint) {
                          const g = hook.savepoint;
                          hook.savepoint = null;
                          g();
                        }
                        return sp(f);
                      };
                    const v = Reflect.get(tt, kk);
                    return typeof v === 'function' ? v.bind(tt) : v;
                  },
                }),
              );
            });
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as typeof db.sql;
    return { sqlx, hook, pgErr };
  };

  it('a deadlock or serialization error is retried, never recorded as a skipped payment', async () => {
    await reset();
    await addAgent(1);
    const logs: Array<Record<string, string | number>> = [];
    const mk = () => fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' }), bad('2'), tr({ opId: '3' })], cursor: 'c1', done: true }] });
    const { sqlx, hook, pgErr } = flaky();
    const go = async (extra = {}) => {
      await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T11:00:00Z')}`;
      await pollPayments({ sql: sqlx, horizon: mk(), cfg: CFG, now, log: (e) => logs.push(e), ...extra });
    };
    for (let i = 0; i < 3; i++) await go(); // the bad row fails the page 3 times: skip mode is on
    expect(await payments()).toHaveLength(0);
    // in skip mode the very first row (a good one) loses a race inside its savepoint: the page is retried, the row is not skipped
    hook.savepoint = () => {
      throw pgErr();
    };
    await go();
    expect(logs.filter((l) => l.event === 'payments_page_retry')).toHaveLength(1);
    expect(logs.filter((l) => l.event === 'payment_row_skipped')).toEqual([{ event: 'payment_row_skipped', op_id: '2' }]);
    expect((await payments()).map((p) => p.op_id)).toEqual(['1', '3']);
    expect((await agent(1)).payments_cursor).toBe('c1');
  });

  it('lost races never count toward skip mode', async () => {
    await reset();
    await addAgent(1);
    const { sqlx, hook, pgErr } = flaky();
    const go = async (transfers: ChainTransfer[], cursor: string) => {
      await db.sql`update discovery.agents set next_poll_at = ${new Date('2026-10-12T11:00:00Z')}`;
      await pollPayments({ sql: sqlx, horizon: fakeHorizon({ [WALLET]: [{ transfers, cursor, done: true }] }), cfg: CFG, now });
    };
    const rows = [tr({ opId: '1' }), bad('2'), tr({ opId: '3' })];
    hook.begin = () => {
      throw pgErr(); // every attempt, retries included, loses the race
    };
    for (let i = 0; i < 3; i++) await go(rows, 'c1');
    hook.begin = null;
    // three lost-race polls later a failing page must still be an ordinary failure, not a skipped row
    await go(rows, 'c1');
    expect(await payments()).toHaveLength(0);
    expect((await agent(1)).payments_cursor).toBeNull();
  });

  it('stops at once when the wallet was rebound, leaving the rebind next_poll_at alone', async () => {
    await reset();
    await addAgent(1);
    const rebindAt = new Date('2026-10-12T11:00:00Z');
    const w2 = Keypair.random().publicKey();
    const h = fakeHorizon({ [WALLET]: [{ transfers: [tr({ opId: '1' })], cursor: 'c1', done: false }, { transfers: [tr({ opId: '2' })], cursor: 'c2', done: false }] });
    const real = h.accountPayments.bind(h);
    h.accountPayments = async (w, c, l) => {
      const r = await real(w, c, l);
      await db.sql`update discovery.agents set wallet = ${w2}, payments_cursor = null, next_poll_at = ${rebindAt} where agent_id = 1`;
      return r;
    };
    await run(h);
    expect(h.calls).toHaveLength(1);
    expect(await payments()).toHaveLength(0);
    const a = await agent(1);
    expect(a.payments_cursor).toBeNull();
    expect(new Date(a.next_poll_at).toISOString()).toBe(rebindAt.toISOString());
  });
});

describe('pollPayments on real x402 settlement shapes', () => {
  // Real testnet settlements (e-chain-shapes.md): invoke_host_function, a channel account as the op source, the OZ
  // facilitator as fee account, 7-decimal amounts. Only the tx-hash prefixes and truncated addresses are real here.
  const FACILITATOR = 'GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL';
  const CHANNEL = Keypair.random().publicKey();
  const SELLER = Keypair.random().publicKey();
  const BUYER_A = Keypair.random().publicKey();
  const BUYER_B = Keypair.random().publicKey();
  const settlement = (id: string, hash: string, from: string) => {
    const rec = sorobanTransfer({ id, hash, token: id, changes: [usdcChange('transfer', from, SELLER, '0.0010000')] });
    return { ...rec, source_account: CHANNEL, transaction: { ...rec.transaction, fee_account: FACILITATOR } };
  };
  const EF = `ef3d755b${'0'.repeat(56)}`;
  const F4 = `f4ba294e${'0'.repeat(56)}`;

  it('counts both as 10000 units from the buyer to the seller, never from the channel or the facilitator', async () => {
    await reset();
    await addAgent(1, { wallet: SELLER });
    // the channel account is itself some other agent's tracked wallet: it must not become the payer
    await addAgent(2, { owner: Keypair.random().publicKey(), wallet: CHANNEL });
    const q = queueFetch([jsonResponse(horizonPage([settlement('10', EF, BUYER_A), settlement('11', F4, BUYER_B)]))]);
    const horizon = createHorizonReader({ horizonUrl: 'https://horizon-testnet.stellar.org', fetch: q.fetch, retry: { sleep: async () => {} } });
    const res = await pollPayments({ sql: db.sql, horizon, cfg: CFG, now, maxWallets: 1 });
    expect(res.inserted).toBe(2);
    const rows = (await payments()).filter((p) => p.agent_id === 1);
    expect(rows.map((p) => [p.tx_hash, p.payer, p.payee, p.amount_units, p.payer_agent_id, p.counted])).toEqual([
      [EF, BUYER_A, SELLER, '10000', null, true],
      [F4, BUYER_B, SELLER, '10000', null, true],
    ]);
    expect(rows.some((p) => p.payer === CHANNEL || p.payer === FACILITATOR)).toBe(false);
    expect((await agent(2)).last_active_at).toBeNull();
  });

  it('counts both for a self-owned seller (owner === wallet) as 10000 units each', async () => {
    await reset();
    await addAgent(1, { owner: SELLER, wallet: SELLER });
    const q = queueFetch([jsonResponse(horizonPage([settlement('10', EF, BUYER_A), settlement('11', F4, BUYER_B)]))]);
    const horizon = createHorizonReader({ horizonUrl: 'https://horizon-testnet.stellar.org', fetch: q.fetch, retry: { sleep: async () => {} } });
    expect((await pollPayments({ sql: db.sql, horizon, cfg: CFG, now })).inserted).toBe(2);
    expect((await payments()).map((p) => [p.tx_hash, p.payer, p.amount_units, p.counted])).toEqual([
      [EF, BUYER_A, '10000', true],
      [F4, BUYER_B, '10000', true],
    ]);
  });
});
