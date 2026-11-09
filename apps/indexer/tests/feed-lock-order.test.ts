import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { followRegistry } from '../src/registry-events.js';
import { pollPayments } from '../src/payments.js';
import { decodeRegistryEvent, type RegistryEvent, type RegistryReader } from '../src/chain/registry.js';
import type { ChainTransfer, HorizonReader } from '../src/chain/horizon.js';
import type { Db } from '../src/db.js';
import { freshDb } from './support/db.js';
import { OWNER, USDC, WALLET, eventId, registration } from './support/fake-chain.js';

const BASE = 'https://agentenact.io';
const NOW = new Date('2026-10-12T12:00:00Z');

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});

/** A Db whose transactions pause (after the statement completes) the first time one matches `re`: a deterministic interleave. */
function pausing(sql: Db, re: RegExp, reached: () => void, gate: Promise<void>): Db {
  let done = false;
  const wrapTx = (tx: any): any =>
    new Proxy(tx, {
      apply(t, th, args) {
        const q = Reflect.apply(t, th, args);
        const text = Array.isArray(args[0]) ? args[0].join('?') : '';
        if (done || !re.test(text)) return q;
        done = true;
        return (async () => {
          const r = await q;
          reached();
          await gate;
          return r;
        })();
      },
      get(t, k) {
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(sql as any, {
    get(t, k) {
      if (k === 'begin') return (cb: (tx: any) => Promise<unknown>) => t.begin((tx: any) => cb(wrapTx(tx)));
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Db;
}

describe('feed lock order', () => {
  it('feed writers take the feed lock before any agent row lock', async () => {
    for (const t of ['agents', 'feed', 'payments', 'registry_events', 'meta']) await db.sql.unsafe(`delete from discovery.${t}`);
    await db.sql`insert into discovery.meta (key, value) values ('events_ledger', '400')`;
    const wa = Keypair.random().publicKey();
    const wx = Keypair.random().publicKey();
    const due = new Date('2026-10-12T11:00:00Z');
    const later = new Date('2030-01-01T00:00:00Z');
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, source, next_poll_at) values (1, ${OWNER}, ${WALLET}, 'event', ${due})`;
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, source, next_poll_at) values (200, ${OWNER}, ${wa}, 'event', ${later})`;
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, source, next_poll_at) values (201, ${OWNER}, ${wx}, 'event', ${later})`;

    // The payments page: a first payer whose row it updates while holding the feed lock, then agent 201 (a payer too).
    const transfers: ChainTransfer[] = [wa, wx].map((from, i) => ({ opId: String(1000 + i), idx: 0, txHash: 'a'.repeat(64), from, to: WALLET, amountUnits: 10000n, asset: USDC, at: '2026-10-12T10:00:00Z' }));
    const horizon: HorizonReader = { accountPayments: async () => ({ transfers, cursor: 'c1', done: true }) };
    // The registry event for agent 201: it locks that row (old order) or the feed lock (new order), then pauses.
    const events = registration({ agentId: 201, ledger: 500, tx: 'd'.repeat(64) }).map((e) => decodeRegistryEvent(e)).filter((e): e is RegistryEvent => e !== null);
    const reader = {
      read: async (id: number) => ({ agentId: id, owner: OWNER, wallet: OWNER, uri: 'data:application/json;base64,e30=' }),
      totalAgents: async () => 0,
      latestLedger: async () => 100000,
      events: async () => ({ events, cursor: eventId(100000, 0), latestLedger: 100000 }),
    } as unknown as RegistryReader;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const paused = new Promise<void>((r) => (reached = r));
    const regSql = pausing(db.sql, /update discovery\.agents set source = 'event'/, () => reached(), gate);

    const reg = followRegistry({ sql: regSql, reader, publicBaseUrl: BASE });
    await paused; // the registry tx holds its locks and is parked
    const pay = pollPayments({ sql: db.sql, horizon, cfg: { usdc: USDC, sponsors: [] }, now: () => NOW });
    // Wait until the payments page is blocked on a lock held by the parked registry tx (a row lock in the old order, the
    // feed lock in the new one).
    for (let i = 0; i < 100; i++) {
      const waiting = (await db.sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`) as unknown[];
      if (waiting.length > 0) break;
      await Bun.sleep(200);
    }
    release();
    const [p, r] = await Promise.all([pay, reg]);

    expect(p.inserted).toBe(2);
    expect(r.applied).toBeGreaterThan(0);
    const feed = (await db.sql`select kind, count(*)::int as n from discovery.feed group by kind order by kind`) as Array<{ kind: string; n: number }>;
    expect(feed).toEqual([
      { kind: 'paid', n: 2 },
      { kind: 'registered', n: 1 },
    ]);
  }, 60_000);
});
