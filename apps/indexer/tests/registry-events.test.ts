import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { followRegistry } from '../src/registry-events.js';
import { decodeRegistryEvent, retentionGap, type RegistryAgent, type RegistryEvent, type RegistryReader } from '../src/chain/registry.js';
import { freshDb } from './support/db.js';
import { OWNER, REGISTRY, WALLET, eventId, ownerTransfer, registration, uriUpdated, walletBound } from './support/fake-chain.js';

const BASE = 'https://agentenact.io';
const UUID = '0b9f3c1e-2d4a-4e5f-8a6b-7c8d9e0f1a2b';
const hostedUri = `${BASE}/a/${UUID}/agent.json`;
const TX = 'd'.repeat(64);

type Page = RegistryEvent[] | Error;
/** Scripted reader: `pages` are served in order; the cursor of each page is a real TOID for `latestLedger`-style walking. */
function fakeReader(o: { agents?: Record<number, RegistryAgent>; pages?: Page[]; latest?: number; total?: number } = {}) {
  const r = {
    agents: o.agents ?? ({} as Record<number, RegistryAgent>),
    pages: o.pages ?? [],
    latest: o.latest ?? 1000,
    total: o.total ?? 0,
    calls: [] as Array<{ startLedger?: number; cursor?: string }>,
    reads: [] as number[],
    async totalAgents() {
      return r.total;
    },
    async read(id: number) {
      r.reads.push(id);
      return r.agents[id] ?? null;
    },
    async latestLedger() {
      return r.latest;
    },
    async events(a: { startLedger?: number; cursor?: string; limit: number }) {
      r.calls.push({ startLedger: a.startLedger, cursor: a.cursor });
      const next = r.pages.shift();
      if (next instanceof Error) throw next;
      const events = next ?? [];
      // Last event's id as cursor, or an empty page whose cursor sits at the latest ledger.
      const cursor = events.length ? events[events.length - 1]!.id : eventId(r.latest, 0);
      return { events, cursor, latestLedger: r.latest };
    },
  };
  return r satisfies RegistryReader & Record<string, unknown>;
}

const decode = (raws: ReturnType<typeof registration>) => raws.map((e) => decodeRegistryEvent(e)).filter((e): e is RegistryEvent => e !== null);
const agentRow = (agentId: number, o: Partial<RegistryAgent> = {}): RegistryAgent => ({ agentId, owner: OWNER, wallet: OWNER, uri: 'data:application/json;base64,e30=', ...o });

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});
const reset = async () => {
  for (const t of ['agents', 'feed', 'meta', 'registry_events']) await db.sql.unsafe(`delete from discovery.${t}`);
};
const follow = (reader: ReturnType<typeof fakeReader>) => followRegistry({ sql: db.sql, reader, publicBaseUrl: BASE });
const seed = async (events_ledger = 400) => {
  await db.sql`insert into discovery.meta (key, value) values ('events_ledger', ${String(events_ledger)})`;
};

describe('followRegistry', () => {
  it('turns a Registered event into an agent, an event row and one feed line', async () => {
    await reset();
    await seed();
    const evs = decode(registration({ agentId: 7, tx: TX, ledger: 500 }));
    const reader = fakeReader({ agents: { 7: agentRow(7, { uri: hostedUri }) }, pages: [evs] });
    const res = await follow(reader);
    expect(res.status).toBe('ok');
    expect(res.applied).toBe(2); // mint is not decoded
    const [a]: any[] = await db.sql`select * from discovery.agents where agent_id = 7`;
    expect(a).toMatchObject({ source: 'event', registered_tx: TX, registered_ledger: 500, builder: 'external', hosted_uuid: UUID, owner: OWNER, wallet: OWNER });
    expect(new Date(a.registered_at).toISOString()).toBe('2026-10-12T10:00:05.000Z');
    expect(a.tracked_wallet).toBe(OWNER); // self-owned: tracked, polled from the start
    expect(a.payments_cursor).toBeNull();
    const kinds: any[] = await db.sql`select kind from discovery.registry_events where agent_id = 7 order by kind`;
    expect(kinds.map((k) => k.kind)).toEqual(['registered', 'wallet_bound']);
    const feed: any[] = await db.sql`select * from discovery.feed`;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'registered', agent_id: 7, tx_hash: TX, source_key: 'reg:7', self_published: false });
  });

  it('replaying the same events changes nothing', async () => {
    await reset();
    await seed();
    const evs = decode(registration({ agentId: 7, tx: TX }));
    const agents = { 7: agentRow(7) };
    await follow(fakeReader({ agents, pages: [evs] }));
    const snap = async () => [await db.sql`select * from discovery.agents`, await db.sql`select * from discovery.registry_events order by event_id`, await db.sql`select * from discovery.feed`];
    const before = await snap();
    await db.sql`delete from discovery.meta where key = 'events_cursor'`;
    const res = await follow(fakeReader({ agents, pages: [evs] }));
    expect(res.applied).toBe(0);
    expect(await snap()).toEqual(before);
  });

  it('fills in the tx hash of an agent first seen by a registry read', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (7, ${OWNER}, ${OWNER}, '', 'registry_read')`;
    await follow(fakeReader({ agents: { 7: agentRow(7) }, pages: [decode(registration({ agentId: 7, tx: TX, ledger: 500 }))] }));
    const [a]: any[] = await db.sql`select source, registered_tx, registered_ledger from discovery.agents where agent_id = 7`;
    expect(a).toEqual({ source: 'event', registered_tx: TX, registered_ledger: 500 });
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(1);
  });

  it('a wallet MetadataSet updates the wallet and resets the payments cursor only when it changed', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, payments_cursor) values (3, ${OWNER}, ${OWNER}, '', 'event', 'cur-1')`;
    // the event value is not trusted: the reader decides what the wallet is
    const bind = decode([walletBound({ agentId: 3, wallet: WALLET, ledger: 510 })]);
    await follow(fakeReader({ agents: { 3: agentRow(3, { wallet: WALLET }) }, pages: [bind] }));
    let [a]: any[] = await db.sql`select wallet, tracked_wallet, payments_cursor from discovery.agents where agent_id = 3`;
    expect(a).toEqual({ wallet: WALLET, tracked_wallet: WALLET, payments_cursor: null });

    await db.sql`update discovery.agents set payments_cursor = 'cur-2' where agent_id = 3`;
    const again = decode([walletBound({ agentId: 3, wallet: WALLET, ledger: 520 })]);
    await follow(fakeReader({ agents: { 3: agentRow(3, { wallet: WALLET }) }, pages: [again] }));
    [a] = await db.sql`select payments_cursor from discovery.agents where agent_id = 3`;
    expect(a.payments_cursor).toBe('cur-2');
  });

  it('an ownership transfer re-reads the agent', async () => {
    await reset();
    await seed();
    const NEW_OWNER = Keypair.random().publicKey();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (4, ${OWNER}, ${WALLET}, '', 'event')`;
    await follow(fakeReader({ agents: { 4: agentRow(4, { owner: NEW_OWNER, wallet: WALLET }) }, pages: [decode([ownerTransfer({ agentId: 4, from: OWNER, to: NEW_OWNER })])] }));
    const [a]: any[] = await db.sql`select owner, wallet from discovery.agents where agent_id = 4`;
    expect(a).toEqual({ owner: NEW_OWNER, wallet: WALLET });
    expect((await db.sql`select kind from discovery.registry_events`)[0].kind).toBe('owner_changed');
  });

  it('a UriUpdated to the hosted pattern records the claim only; builder stays external', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (5, ${OWNER}, ${OWNER}, 'https://x.example/a.json', 'event')`;
    const reader = fakeReader({ pages: [decode([uriUpdated({ agentId: 5, uri: hostedUri, ledger: 510 })])] });
    await follow(reader);
    expect(reader.reads).toEqual([]);
    let [a]: any[] = await db.sql`select uri, builder, hosted_uuid from discovery.agents where agent_id = 5`;
    expect(a).toEqual({ uri: hostedUri, builder: 'external', hosted_uuid: UUID });
    await follow(fakeReader({ pages: [decode([uriUpdated({ agentId: 5, uri: 'ipfs://abc', ledger: 520 })])] }));
    [a] = await db.sql`select uri, builder, hosted_uuid from discovery.agents where agent_id = 5`;
    expect(a).toEqual({ uri: 'ipfs://abc', builder: 'external', hosted_uuid: null });
  });

  it('a Registered event with a spoofed hosted uri leaves builder external and records the claim', async () => {
    await reset();
    await seed();
    const reader = fakeReader({ agents: { 8: agentRow(8, { uri: hostedUri }) }, pages: [decode(registration({ agentId: 8, tx: TX, ledger: 500 }))] });
    await follow(reader);
    const [a]: any[] = await db.sql`select builder, hosted_uuid from discovery.agents where agent_id = 8`;
    expect(a).toEqual({ builder: 'external', hosted_uuid: UUID });
  });

  it('a UriUpdated that changes the claim on a verified-hosted row resets builder to external', async () => {
    await reset();
    await seed();
    const OTHER = '1c0a4d2f-3e5b-4f60-9b7c-8d9eaf0b2c3d';
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid) values (6, ${OWNER}, ${OWNER}, ${hostedUri}, 'event', 'hosted', ${UUID})`;
    await follow(fakeReader({ pages: [decode([uriUpdated({ agentId: 6, uri: `${BASE}/a/${OTHER}/agent.json`, ledger: 510 })])] }));
    const [a]: any[] = await db.sql`select builder, hosted_uuid from discovery.agents where agent_id = 6`;
    expect(a).toEqual({ builder: 'external', hosted_uuid: OTHER });
  });

  it('a UriUpdated with the same claim keeps a verified-hosted row hosted', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid) values (6, ${OWNER}, ${OWNER}, ${hostedUri}, 'event', 'hosted', ${UUID})`;
    await follow(fakeReader({ pages: [decode([uriUpdated({ agentId: 6, uri: hostedUri, ledger: 510 })])] }));
    const [a]: any[] = await db.sql`select builder, hosted_uuid from discovery.agents where agent_id = 6`;
    expect(a).toEqual({ builder: 'hosted', hosted_uuid: UUID });
  });

  it('an event for an agent we do not hold reads that one id first', async () => {
    await reset();
    await seed();
    const reader = fakeReader({ agents: { 9: agentRow(9, { uri: 'ipfs://old' }) }, pages: [decode([uriUpdated({ agentId: 9, uri: hostedUri, ledger: 510 })])] });
    await follow(reader);
    expect(reader.reads).toEqual([9]);
    const [a]: any[] = await db.sql`select source, uri, builder from discovery.agents where agent_id = 9`;
    expect(a).toEqual({ source: 'registry_read', uri: hostedUri, builder: 'external' });
  });

  it('last_active_at only moves forward', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (6, ${OWNER}, ${OWNER}, '', 'event')`;
    await follow(fakeReader({ pages: [decode([uriUpdated({ agentId: 6, uri: 'ipfs://a', ledger: 600 })])] }));
    const late = (await db.sql`select last_active_at from discovery.agents where agent_id = 6`)[0].last_active_at;
    expect(late).not.toBeNull();
    await db.sql`update discovery.agents set last_active_at = '2026-10-13T00:00:00Z' where agent_id = 6`;
    await follow(fakeReader({ pages: [decode([uriUpdated({ agentId: 6, uri: 'ipfs://b', ledger: 601 })])] }));
    expect(new Date((await db.sql`select last_active_at from discovery.agents where agent_id = 6`)[0].last_active_at).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('walks empty pages until the cursor reaches the latest ledger, then stores the cursor', async () => {
    await reset();
    await seed();
    const reader = fakeReader({ latest: 1000, pages: [[], [], decode([uriUpdated({ agentId: 6, uri: 'ipfs://a', ledger: 700 })]), []] });
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (6, ${OWNER}, ${OWNER}, '', 'event')`;
    // an empty page whose cursor is still short of latest must not end the walk
    const slow = { ...reader, async events(a: any) {
      reader.calls.push({ startLedger: a.startLedger, cursor: a.cursor });
      const n = reader.calls.length;
      if (n === 1) return { events: [], cursor: eventId(500, 0), latestLedger: 1000 };
      if (n === 2) return { events: [], cursor: eventId(900, 0), latestLedger: 1000 };
      if (n === 3) return { events: decode([uriUpdated({ agentId: 6, uri: 'ipfs://z', ledger: 950 })]), cursor: eventId(950, 0), latestLedger: 1000 };
      return { events: [], cursor: eventId(1000, 0), latestLedger: 1000 };
    } };
    const res = await followRegistry({ sql: db.sql, reader: slow as any, publicBaseUrl: BASE });
    expect(res).toEqual({ applied: 1, status: 'ok' });
    expect(reader.calls).toHaveLength(4);
    expect(reader.calls[0]).toEqual({ startLedger: 400, cursor: undefined });
    expect(reader.calls[1]!.cursor).toBe(eventId(500, 0));
    expect((await db.sql`select value from discovery.meta where key = 'events_cursor'`)[0].value).toBe(eventId(1000, 0));
    // next run resumes from the stored cursor
    const next = fakeReader({ latest: 1000, pages: [[]] });
    await follow(next);
    expect(next.calls[0]).toEqual({ startLedger: undefined, cursor: eventId(1000, 0) });
  });

  it('a retention gap triggers a reconcile and resets the ledger, without throwing', async () => {
    await reset();
    await seed(100);
    await db.sql`insert into discovery.meta (key, value) values ('events_cursor', ${eventId(100, 0)})`;
    const reader = fakeReader({ latest: 5000, total: 2, agents: { 0: agentRow(0), 1: agentRow(1) }, pages: [retentionGap(4000)] });
    const res = await follow(reader);
    expect(res).toEqual({ applied: 0, status: 'reconciled' });
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(2);
    expect((await db.sql`select value from discovery.meta where key = 'events_ledger'`)[0].value).toBe('5000');
    expect((await db.sql`select count(*)::int as n from discovery.meta where key = 'events_cursor'`)[0].n).toBe(0);
    // the following run starts from the new ledger
    const next = fakeReader({ latest: 5010, total: 2, pages: [[]] });
    await follow(next);
    expect(next.calls[0]).toEqual({ startLedger: 5000, cursor: undefined });
  });

  it('first run records the ledger before the walk so a registration made during the walk is read from events', async () => {
    await reset();
    const evs = decode(registration({ agentId: 2, tx: TX, ledger: 1001 }));
    const reader = fakeReader({ latest: 1000, total: 2, agents: { 0: agentRow(0), 1: agentRow(1), 2: agentRow(2) }, pages: [evs] });
    // the chain advances (agent 2 registers) while reconcile walks: the ledger was captured first
    const origTotal = reader.totalAgents.bind(reader);
    reader.totalAgents = async () => {
      const n = await origTotal();
      reader.latest = 1010;
      return n;
    };
    const res = await follow(reader);
    expect(res.status).toBe('ok');
    expect(reader.calls[0]).toEqual({ startLedger: 1000, cursor: undefined });
    const [a]: any[] = await db.sql`select source, registered_tx from discovery.agents where agent_id = 2`;
    expect(a).toEqual({ source: 'event', registered_tx: TX });
    expect((await db.sql`select value from discovery.meta where key = 'events_ledger'`)[0].value).toBe('1000');
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(3);
  });

  it('a Registered event whose read returns null (lagging backend) still records the agent, tx and feed line from the event', async () => {
    await reset();
    await seed();
    const evs = decode(registration({ agentId: 7, tx: TX, ledger: 500, uri: hostedUri }));
    const reader = fakeReader({ agents: {}, pages: [evs] }); // read(7) -> null
    const res = await follow(reader);
    expect(res.status).toBe('ok');
    const [a]: any[] = await db.sql`select * from discovery.agents where agent_id = 7`;
    expect(a).toMatchObject({ owner: OWNER, wallet: null, uri: hostedUri, source: 'event', registered_tx: TX, registered_ledger: 500, builder: 'external', hosted_uuid: UUID });
    expect((await db.sql`select count(*)::int as n from discovery.feed where source_key = 'reg:7'`)[0].n).toBe(1);
    expect((await db.sql`select count(*)::int as n from discovery.registry_events where kind = 'registered'`)[0].n).toBe(1);
    // the next refresh fills the wallet
    const reconcile = await (await import('../src/registry-sync.js')).reconcileRegistry({ sql: db.sql, reader: fakeReader({ total: 8, agents: { 7: agentRow(7, { wallet: WALLET, uri: hostedUri }) } }), publicBaseUrl: BASE });
    expect(reconcile.status).toBe('ok');
    expect((await db.sql`select wallet from discovery.agents where agent_id = 7`)[0].wallet).toBe(WALLET);
  });

  it('a lagging read on a held agent still fills registered_tx and the feed line', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (7, ${OWNER}, ${OWNER}, '', 'registry_read')`;
    await follow(fakeReader({ agents: {}, pages: [decode(registration({ agentId: 7, tx: TX, ledger: 500 }))] }));
    const [a]: any[] = await db.sql`select source, registered_tx from discovery.agents where agent_id = 7`;
    expect(a).toEqual({ source: 'event', registered_tx: TX });
    expect((await db.sql`select count(*)::int as n from discovery.feed`)[0].n).toBe(1);
  });

  it('a contract-kind read error skips a non-registered event with a fixed log and does not rethrow; transport errors still throw', async () => {
    await reset();
    await seed();
    const logs: Array<Record<string, string | number>> = [];
    const bind = decode([walletBound({ agentId: 3, wallet: WALLET, ledger: 510 })]);
    const reader = fakeReader({ pages: [bind] });
    reader.read = async () => {
      throw Object.assign(new Error('registry find_owner failed: secret detail'), { kind: 'contract' });
    };
    const res = await followRegistry({ sql: db.sql, reader, publicBaseUrl: BASE, log: (e) => logs.push(e) });
    expect(res.status).toBe('ok');
    expect(logs).toEqual([{ event: 'registry_event_read_failed', id: 3, kind: 'wallet_bound' }]);
    expect((await db.sql`select count(*)::int as n from discovery.registry_events`)[0].n).toBe(0);

    const flaky = fakeReader({ pages: [bind] });
    flaky.read = async () => {
      throw Object.assign(new Error('fetch failed'), { kind: 'http', status: 503 });
    };
    await expect(follow(flaky)).rejects.toThrow('fetch failed');
  });

  it('a contract-kind read error on a Registered event still records it from the event', async () => {
    await reset();
    await seed();
    const reader = fakeReader({ pages: [decode(registration({ agentId: 7, tx: TX }))] });
    reader.read = async () => {
      throw Object.assign(new Error('x'), { kind: 'contract' });
    };
    await follow(reader);
    expect((await db.sql`select registered_tx from discovery.agents where agent_id = 7`)[0].registered_tx).toBe(TX);
  });

  it('a registration metadata_set (null wallet -> owner) starts polling the owner wallet; an unchanged wallet keeps the cursor', async () => {
    await reset();
    await seed();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, payments_cursor, next_poll_at) values (3, ${OWNER}, null, '', 'event', 'cur-1', '2030-01-01')`;
    await follow(fakeReader({ agents: { 3: agentRow(3, { wallet: OWNER }) }, pages: [decode([walletBound({ agentId: 3, wallet: OWNER, ledger: 510 })])] }));
    let [a]: any[] = await db.sql`select wallet, tracked_wallet, payments_cursor, next_poll_at <= now() as due from discovery.agents where agent_id = 3`;
    expect(a).toEqual({ wallet: OWNER, tracked_wallet: OWNER, payments_cursor: null, due: true });
    await db.sql`update discovery.agents set payments_cursor = 'cur-2' where agent_id = 3`;
    await follow(fakeReader({ agents: { 3: agentRow(3, { wallet: OWNER }) }, pages: [decode([walletBound({ agentId: 3, wallet: OWNER, ledger: 511 })])] }));
    [a] = await db.sql`select payments_cursor from discovery.agents where agent_id = 3`;
    expect(a.payments_cursor).toBe('cur-2');
  });

  it('a wallet or owner change drops a verified-hosted builder to external right away; unchanged keeps it', async () => {
    await reset();
    await seed();
    const NEW_OWNER = Keypair.random().publicKey();
    for (const id of [10, 11, 12]) {
      await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid) values (${id}, ${OWNER}, ${WALLET}, ${hostedUri}, 'event', 'hosted', ${UUID})`;
    }
    await follow(
      fakeReader({
        agents: { 10: agentRow(10, { wallet: Keypair.random().publicKey(), uri: hostedUri }), 11: agentRow(11, { owner: NEW_OWNER, wallet: WALLET, uri: hostedUri }), 12: agentRow(12, { wallet: WALLET, uri: hostedUri }) },
        pages: [decode([walletBound({ agentId: 10, wallet: WALLET, ledger: 510 }), ownerTransfer({ agentId: 11, from: OWNER, to: NEW_OWNER, ledger: 511 }), walletBound({ agentId: 12, wallet: WALLET, ledger: 512 })])],
      }),
    );
    const rows: any[] = await db.sql`select agent_id, builder from discovery.agents order by agent_id`;
    expect(rows.map((r) => [r.agent_id, r.builder])).toEqual([[10, 'external'], [11, 'external'], [12, 'hosted']]);
  });

  it('the registration-time metadata_set (wallet = owner) is stored but excluded from activity; a real bind is activity', async () => {
    await reset();
    await seed();
    await follow(fakeReader({ agents: { 7: agentRow(7) }, pages: [decode(registration({ agentId: 7, tx: TX }))] }));
    await follow(fakeReader({ agents: { 7: agentRow(7, { wallet: WALLET }) }, pages: [decode([walletBound({ agentId: 7, wallet: WALLET, ledger: 600 })])] }));
    const stored: any[] = await db.sql`select kind, inert from discovery.registry_events where agent_id = 7 order by ledger, kind`;
    expect(stored.map((r) => [r.kind, r.inert])).toEqual([['registered', false], ['wallet_bound', true], ['wallet_bound', false]]);
    const act: any[] = await db.sql`select kind from discovery.activity where agent_id = 7 order by kind`;
    expect(act.map((r) => r.kind)).toEqual(['registered', 'wallet_bound']);
  });

  describe('chain reset', () => {
    it('reconcile chain_reset is returned, and neither ledger nor cursor moves', async () => {
      await reset();
      await seed(400);
      await db.sql`insert into discovery.meta (key, value) values ('events_cursor', ${eventId(450, 0)})`;
      await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (5, ${OWNER}, ${OWNER}, '', 'event')`;
      // the retention gap forces a reconcile; total (2) is below the held max id (5)
      const reader = fakeReader({ latest: 5000, total: 2, pages: [retentionGap(4000)] });
      const logs: Array<Record<string, string | number>> = [];
      const res = await followRegistry({ sql: db.sql, reader, publicBaseUrl: BASE, log: (e) => logs.push(e) });
      expect(res).toEqual({ applied: 0, status: 'chain_reset' });
      expect((await db.sql`select value from discovery.meta where key = 'events_ledger'`)[0].value).toBe('400');
      expect((await db.sql`select value from discovery.meta where key = 'events_cursor'`)[0].value).toBe(eventId(450, 0));
      expect(logs.some((l) => l.event === 'registry_chain_reset')).toBe(true);
    });

    it('a reset found by the first-run reconcile does not record events_ledger', async () => {
      await reset();
      await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source) values (5, ${OWNER}, ${OWNER}, '', 'event')`;
      const res = await follow(fakeReader({ latest: 1000, total: 2 }));
      expect(res.status).toBe('chain_reset');
      expect((await db.sql`select count(*)::int as n from discovery.meta where key in ('events_ledger', 'events_cursor')`)[0].n).toBe(0);
    });

    it('registryId is passed to reconcile: a different pinned contract is a reset', async () => {
      await reset();
      await seed();
      await db.sql`insert into discovery.meta (key, value) values ('registry_contract', ${REGISTRY})`;
      const res = await followRegistry({ sql: db.sql, reader: fakeReader({ latest: 5000, pages: [retentionGap(4000)] }), publicBaseUrl: BASE, registryId: 'C'.padEnd(56, 'A') });
      expect(res.status).toBe('chain_reset');
    });

    // A real reset drops the ledger far below what we processed and stays there; one sample from a lagging RPC backend is noise.
    const clock = (start = Date.parse('2026-10-15T12:00:00Z')) => {
      let t = start;
      return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
    };
    const followAt = (reader: ReturnType<typeof fakeReader>, c: ReturnType<typeof clock>, logs: Array<Record<string, string | number>> = []) =>
      followRegistry({ sql: db.sql, reader, publicBaseUrl: BASE, now: c.now, log: (e) => logs.push(e) });

    it('one RPC sample far below events_ledger is only suspect: nothing is read, written or halted', async () => {
      await reset();
      await seed(5000);
      const reader = fakeReader({ latest: 1000, pages: [decode(registration({ agentId: 7, tx: TX }))] });
      const logs: Array<Record<string, string | number>> = [];
      const res = await followAt(reader, clock(), logs);
      expect(res).toEqual({ applied: 0, status: 'suspect' });
      expect(reader.calls).toEqual([]);
      expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(0);
      expect((await db.sql`select value from discovery.meta where key = 'events_ledger'`)[0].value).toBe('5000');
      expect(logs).toEqual([{ event: 'registry_ledger_suspect', latest: 1000, events_ledger: 5000, samples: 1 }]);
    });

    it('three samples over at least 15 s below events_ledger are a reset; nothing is read or written', async () => {
      await reset();
      await seed(5000);
      const reader = fakeReader({ latest: 1000, pages: [decode(registration({ agentId: 7, tx: TX }))] });
      const logs: Array<Record<string, string | number>> = [];
      const c = clock();
      expect((await followAt(reader, c, logs)).status).toBe('suspect');
      c.advance(5_000);
      expect((await followAt(reader, c, logs)).status).toBe('suspect');
      c.advance(5_000);
      expect((await followAt(reader, c, logs)).status).toBe('suspect'); // three samples but only 10 s
      c.advance(5_000);
      expect(await followAt(reader, c, logs)).toEqual({ applied: 0, status: 'chain_reset' });
      expect(reader.calls).toEqual([]);
      expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(0);
      expect(logs.at(-1)).toEqual({ event: 'registry_chain_reset', signal: 'ledger_regressed', latest: 1000, events_ledger: 5000 });
    });

    it('a backend one or a few ledgers behind never counts, however long it lasts', async () => {
      await reset();
      await seed(5000);
      await db.sql`insert into discovery.meta (key, value) values ('events_cursor', ${eventId(5000, 0)})`;
      const reader = fakeReader({ latest: 4999, pages: [[], [], [], [], []] });
      const c = clock();
      for (let i = 0; i < 6; i++) {
        expect((await followAt(reader, c)).status).toBe('ok');
        c.advance(10_000);
      }
      expect(reader.calls.length).toBeGreaterThan(0); // it kept following the chain
    });

    it('a sample that is back at the tip clears the streak', async () => {
      await reset();
      await seed(5000);
      const reader = fakeReader({ latest: 1000, pages: [[]] });
      const c = clock();
      await followAt(reader, c);
      c.advance(10_000);
      await followAt(reader, c);
      c.advance(10_000);
      reader.latest = 5001; // the lagging backend caught up
      expect((await followAt(reader, c)).status).toBe('ok');
      reader.latest = 1000;
      for (let i = 0; i < 2; i++) {
        c.advance(10_000);
        expect((await followAt(reader, c)).status).toBe('suspect'); // starts counting from one again
      }
      c.advance(10_000);
      expect((await followAt(reader, c)).status).toBe('chain_reset');
    });

    it('the RPC latest ledger far below the stored cursor ledger is a reset once it persists', async () => {
      await reset();
      await seed(100);
      await db.sql`insert into discovery.meta (key, value) values ('events_cursor', ${eventId(900, 0)})`;
      const reader = fakeReader({ latest: 500, pages: [[]] });
      const c = clock();
      expect((await followAt(reader, c)).status).toBe('suspect');
      c.advance(10_000);
      await followAt(reader, c);
      c.advance(10_000);
      expect((await followAt(reader, c)).status).toBe('chain_reset');
      expect(reader.calls).toEqual([]);
      expect((await db.sql`select value from discovery.meta where key = 'events_cursor'`)[0].value).toBe(eventId(900, 0));
    });
  });
});
