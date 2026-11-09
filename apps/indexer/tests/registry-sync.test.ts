import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { classifyUri, reconcileRegistry } from '../src/registry-sync.js';
import type { RegistryAgent, RegistryReader } from '../src/chain/registry.js';
import { freshDb } from './support/db.js';
import { OWNER, REGISTRY, WALLET } from './support/fake-chain.js';
import { Keypair } from '@stellar/stellar-sdk';

const BASE = 'https://agentenact.io';
const UUID = '0b9f3c1e-2d4a-4e5f-8a6b-7c8d9e0f1a2b';
const hostedUri = `${BASE}/a/${UUID}/agent.json`;
const NOW = new Date('2026-10-12T12:00:00Z');

type Slot = RegistryAgent | null;
/** `fail` ids throw like the live registry's `Error(Contract, #2)` when a read cannot complete; `onRead` runs mid-read. */
function fakeReader(slots: Slot[], total?: number) {
  const r = {
    slots,
    total: total ?? slots.length,
    reads: [] as number[],
    fail: new Set<number>(),
    onRead: undefined as undefined | ((id: number) => Promise<void>),
    async totalAgents() {
      return r.total;
    },
    async read(id: number) {
      r.reads.push(id);
      if (r.fail.has(id)) throw Object.assign(new Error('registry agent_exists failed: HostError: Error(Contract, #2)'), { kind: 'contract' });
      const got = r.slots[id] ?? null;
      await r.onRead?.(id);
      return got;
    },
    async latestLedger() {
      return 1;
    },
    async events() {
      return { events: [], cursor: null, latestLedger: 1 };
    },
  };
  return r;
}
const agent = (agentId: number, o: Partial<RegistryAgent> = {}): RegistryAgent => ({ agentId, owner: OWNER, wallet: OWNER, uri: 'data:application/json;base64,e30=', ...o });
const many = (n: number) => Array.from({ length: n }, (_, i) => agent(i));

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.drop();
});
const reset = async () => {
  await db.sql`delete from discovery.agents`;
  await db.sql`delete from discovery.feed`;
  await db.sql`delete from discovery.meta`;
};
type Extra = { concurrency?: number; refreshPerRun?: number; now?: () => Date; registryId?: string | undefined; log?: (e: Record<string, string | number>) => void };
const run = (reader: RegistryReader, extra: Extra = {}) =>
  reconcileRegistry({ sql: db.sql, reader, publicBaseUrl: BASE, registryId: REGISTRY, now: () => NOW, ...extra });
const later = (ms: number) => () => new Date(NOW.getTime() + ms);
const HOUR = 3600_000;

describe('classifyUri', () => {
  it('tags a hosted agent from its uri and not from a lookalike', () => {
    expect(classifyUri(hostedUri, BASE)).toEqual({ hostedUuid: UUID });
    expect(classifyUri(hostedUri, `${BASE}/`)).toEqual({ hostedUuid: UUID });
    for (const bad of [
      `https://agentenact.io.evil.com/a/${UUID}/agent.json`,
      `${hostedUri}?x=1`,
      `http://agentenact.io/a/${UUID}/agent.json`,
      `${BASE}/a/${UUID.toUpperCase()}/agent.json/extra`,
      `${BASE}/a/${UUID.toUpperCase()}/agent.json`,
      `${BASE}/a/${UUID}/agent.json/`,
      `${BASE}/x/a/${UUID}/agent.json`,
      '',
    ]) {
      expect(classifyUri(bad, BASE)).toEqual({ hostedUuid: null });
    }
  });
});

describe('reconcileRegistry', () => {
  it('inserts every id from 0 to total-1 as registry_read with no tx and no feed rows', async () => {
    await reset();
    const res = await run(fakeReader(many(5)));
    expect(res).toEqual({ added: 5, refreshed: 0, status: 'ok' });
    const rows = await db.sql`select * from discovery.agents order by agent_id`;
    expect(rows.map((r: any) => r.agent_id)).toEqual([0, 1, 2, 3, 4]);
    for (const r of rows as any[]) {
      expect(r.source).toBe('registry_read');
      expect(r.registered_tx).toBeNull();
      expect(r.builder).toBe('external');
      expect(new Date(r.first_seen_at).toISOString()).toBe(NOW.toISOString());
    }
    expect((await db.sql`select count(*)::int as n from discovery.feed`)[0].n).toBe(0);
  });

  it('a second run with the same total adds nothing', async () => {
    await reset();
    const reader = fakeReader(many(3));
    await run(reader);
    expect((await run(reader)).added).toBe(0);
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(3);
  });

  it('adds only the new ids when the total grows', async () => {
    await reset();
    const reader = fakeReader(many(3));
    await run(reader);
    reader.slots.push(agent(3), agent(4));
    reader.total = 5;
    reader.reads.length = 0;
    expect((await run(reader)).added).toBe(2);
    expect(reader.reads.filter((i) => i >= 3).sort()).toEqual([3, 4]);
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(5);
  });

  it('returns chain_reset and changes nothing when total is below what we hold', async () => {
    await reset();
    await run(fakeReader(many(4)));
    const before = await db.sql`select * from discovery.agents order by agent_id`;
    const res = await run(fakeReader(many(2)));
    expect(res).toEqual({ added: 0, refreshed: 0, status: 'chain_reset' });
    expect(await db.sql`select * from discovery.agents order by agent_id`).toEqual(before);
  });

  it('skips an id whose read returns null and picks it up next run', async () => {
    await reset();
    const reader = fakeReader([agent(0), null, agent(2)]);
    expect((await run(reader)).added).toBe(2);
    expect((await db.sql`select agent_id from discovery.agents order by agent_id`).map((r: any) => r.agent_id)).toEqual([0, 2]);
    reader.slots[1] = agent(1);
    reader.reads.length = 0;
    expect((await run(reader)).added).toBe(0); // backing off: a null id is not re-read within the hour
    expect(reader.reads).not.toContain(1);
    expect((await run(reader, { now: later(HOUR + 1000) })).added).toBe(1);
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(3);
  });

  it('a spoofed hosted uri records the claim but stays external after reconcile', async () => {
    await reset();
    const reader = fakeReader([agent(0, { uri: hostedUri }), agent(1, { uri: `${hostedUri}?x=1` })]);
    await run(reader);
    await run(reader); // and after a refresh pass
    const rows: any[] = await db.sql`select agent_id, builder, hosted_uuid, uri from discovery.agents order by agent_id`;
    expect(rows[0]).toMatchObject({ builder: 'external', hosted_uuid: UUID, uri: hostedUri });
    expect(rows[1]).toMatchObject({ builder: 'external', hosted_uuid: null });
  });

  it('a verified hosted agent keeps builder while its claim is unchanged and drops to external when the claim changes', async () => {
    await reset();
    const reader = fakeReader([agent(0, { uri: hostedUri }), agent(1)]);
    await run(reader);
    await db.sql`update discovery.agents set builder = 'hosted' where agent_id = 0`; // what selfpub does after verifying
    await run(reader);
    expect((await db.sql`select builder from discovery.agents where agent_id = 0`)[0].builder).toBe('hosted');
    reader.slots[0] = agent(0, { uri: 'https://elsewhere.example/agent.json' });
    await db.sql`delete from discovery.meta where key = 'refresh_cursor'`;
    await run(reader);
    expect((await db.sql`select builder, hosted_uuid from discovery.agents where agent_id = 0`)[0]).toMatchObject({ builder: 'external', hosted_uuid: null });
  });

  it('a self-owned agent (wallet equals owner) is tracked, an agent without a wallet is not; a wallet change resets the payments cursor', async () => {
    await reset();
    const reader = fakeReader([agent(0), agent(1, { wallet: null })]);
    await run(reader);
    const rows: any[] = await db.sql`select agent_id, tracked_wallet from discovery.agents order by agent_id`;
    expect(rows.map((r) => r.tracked_wallet)).toEqual([OWNER, null]);

    await db.sql`update discovery.agents set payments_cursor = 'c-1', next_poll_at = ${new Date('2027-01-01T00:00:00Z')} where agent_id = 0`;
    reader.slots[0] = agent(0, { wallet: WALLET });
    const res = await run(reader);
    expect(res.refreshed).toBe(2);
    const [a]: any[] = await db.sql`select tracked_wallet, wallet, payments_cursor, next_poll_at from discovery.agents where agent_id = 0`;
    expect(a.tracked_wallet).toBe(WALLET);
    expect(a.payments_cursor).toBeNull();
    expect(new Date(a.next_poll_at).toISOString()).toBe(NOW.toISOString());
  });

  it('an unchanged wallet keeps the cursor; owner and uri refresh', async () => {
    await reset();
    const reader = fakeReader([agent(0, { wallet: WALLET }), agent(1)]);
    await run(reader);
    await db.sql`update discovery.agents set payments_cursor = 'c-9' where agent_id = 0`;
    const newOwner = Keypair.random().publicKey();
    reader.slots[0] = agent(0, { owner: newOwner, wallet: WALLET, uri: hostedUri });
    await run(reader);
    const [a]: any[] = await db.sql`select owner, uri, builder, hosted_uuid, payments_cursor from discovery.agents where agent_id = 0`;
    expect(a).toMatchObject({ owner: newOwner, uri: hostedUri, builder: 'external', hosted_uuid: UUID, payments_cursor: 'c-9' });
  });

  it('refreshes 5 agents per run by default', async () => {
    await reset();
    const reader = fakeReader(many(12));
    await run(reader);
    reader.reads.length = 0;
    expect((await run(reader)).refreshed).toBe(5);
    expect(reader.reads.slice(1).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('refreshes refreshPerRun agents per run round-robin and wraps', async () => {
    await reset();
    const reader = fakeReader(many(45));
    await run(reader);
    const refreshed = async () => {
      reader.reads.length = 0;
      const res = await run(reader, { refreshPerRun: 20 });
      expect(res.refreshed).toBe(20);
      return reader.reads.slice(1).sort((a, b) => a - b); // reads[0] is the reset probe of the highest held id
    };
    const r1 = await refreshed();
    expect(r1).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const r2 = await refreshed();
    expect(r2).toEqual(Array.from({ length: 20 }, (_, i) => i + 20));
    const r3 = await refreshed(); // 40..44 then wraps to 0..14
    expect(r3).toEqual([...Array.from({ length: 15 }, (_, i) => i), 40, 41, 42, 43, 44]);
    expect((await db.sql`select value from discovery.meta where key = 'refresh_cursor'`)[0].value).toBe('14');
  });

  it('a refresh read that returns null leaves the row alone', async () => {
    await reset();
    const reader = fakeReader([agent(0, { wallet: WALLET })]);
    await run(reader);
    reader.slots[0] = null;
    const res = await run(reader);
    expect(res.refreshed).toBe(0);
    expect((await db.sql`select wallet from discovery.agents where agent_id = 0`)[0].wallet).toBe(WALLET);
  });

  it('handles zero agents', async () => {
    await reset();
    expect(await run(fakeReader([]))).toEqual({ added: 0, refreshed: 0, status: 'ok' });
  });

  it('an owner transfer keeps the cursor while the wallet is unchanged', async () => {
    await reset();
    const reader = fakeReader([agent(0, { wallet: WALLET }), agent(1)]);
    await run(reader);
    await db.sql`update discovery.agents set payments_cursor = 'c-3' where agent_id = 0`;
    reader.slots[0] = agent(0, { owner: WALLET, wallet: WALLET }); // owner becomes the wallet: still the same tracked wallet
    await run(reader);
    const [a]: any[] = await db.sql`select tracked_wallet, payments_cursor from discovery.agents where agent_id = 0`;
    expect(a.tracked_wallet).toBe(WALLET);
    expect(a.payments_cursor).toBe('c-3');
  });
});

describe('failures never block the others', () => {
  it('backfill: ids whose read throws are logged and skipped, the rest are inserted', async () => {
    await reset();
    const reader = fakeReader(many(6));
    reader.fail = new Set([1, 4]);
    const logs: Array<Record<string, string | number>> = [];
    const res = await run(reader, { log: (e) => logs.push(e) });
    expect(res).toEqual({ added: 4, refreshed: 0, status: 'ok' });
    expect((await db.sql`select agent_id from discovery.agents order by agent_id`).map((r: any) => r.agent_id)).toEqual([0, 2, 3, 5]);
    expect(logs.filter((l) => l.event === 'registry_read_failed').map((l) => l.id).sort()).toEqual([1, 4]);
    for (const l of logs) expect(Object.values(l).every((v) => typeof v === 'string' || typeof v === 'number')).toBe(true);
  });

  it('a failed id is not re-read within the hour, then is retried', async () => {
    await reset();
    const reader = fakeReader(many(3));
    reader.fail = new Set([1]);
    await run(reader);
    reader.fail.clear();
    reader.reads.length = 0;
    expect((await run(reader)).added).toBe(0);
    expect(reader.reads).not.toContain(1);
    expect((await run(reader, { now: later(HOUR + 1000) })).added).toBe(1);
    expect((await db.sql`select count(*)::int as n from discovery.meta where key = 'skip:1'`)[0].n).toBe(0);
  });

  it('backfill is capped at 50 per tick, oldest ids first', async () => {
    await reset();
    const reader = fakeReader(many(55));
    expect((await run(reader)).added).toBe(50);
    expect((await run(reader)).added).toBe(5);
    expect((await db.sql`select count(*)::int as n from discovery.agents`)[0].n).toBe(55);
  });

  it('refresh: a throwing id is skipped, the others refresh, and the cursor stops at the last processed id', async () => {
    await reset();
    const reader = fakeReader(many(30));
    await run(reader);
    reader.fail = new Set([5, 19]);
    reader.reads.length = 0;
    const res = await run(reader, { refreshPerRun: 20 });
    expect(res.refreshed).toBe(18); // 20 in the window, 2 failed
    // 19 is the last id of the window but failed: the cursor stays at 18 so the next window starts at 19.
    expect((await db.sql`select value from discovery.meta where key = 'refresh_cursor'`)[0].value).toBe('18');
    reader.fail.clear();
    reader.reads.length = 0;
    await run(reader, { refreshPerRun: 20 });
    expect(reader.reads).toContain(19);
  });

  it('refresh: when every read fails the cursor does not move', async () => {
    await reset();
    const reader = fakeReader(many(25));
    await run(reader);
    reader.fail = new Set(Array.from({ length: 25 }, (_, i) => i));
    await run(reader);
    expect((await db.sql`select count(*)::int as n from discovery.meta where key = 'refresh_cursor'`)[0].n).toBe(0);
  });
});

describe('refresh never overwrites newer event data', () => {
  it('a row changed between the read and the write is left as the event wrote it', async () => {
    await reset();
    const reader = fakeReader([agent(0, { uri: 'a' }), agent(1)]);
    await run(reader);
    reader.slots[0] = agent(0, { uri: 'old-chain-read' });
    reader.onRead = async (id) => {
      if (id === 0) await db.sql`update discovery.agents set uri = 'from-event' where agent_id = 0`;
    };
    const res = await run(reader);
    expect(res.refreshed).toBe(1); // only id 1
    expect((await db.sql`select uri from discovery.agents where agent_id = 0`)[0].uri).toBe('from-event');
  });

  it('a change to unrelated columns (payments cursor) does not block the refresh', async () => {
    await reset();
    const reader = fakeReader([agent(0), agent(1)]);
    await run(reader);
    reader.slots[0] = agent(0, { uri: 'new' });
    reader.onRead = async (id) => {
      if (id === 0) await db.sql`update discovery.agents set payments_cursor = 'c-1', last_active_at = now() where agent_id = 0`;
    };
    await run(reader);
    expect((await db.sql`select uri from discovery.agents where agent_id = 0`)[0].uri).toBe('new');
  });
});

describe('chain reset', () => {
  const snapshot = async () => ({
    agents: await db.sql`select * from discovery.agents order by agent_id`,
    meta: await db.sql`select * from discovery.meta order by key`,
  });

  it('the contract id is pinned on the first run; the same id keeps running', async () => {
    await reset();
    await run(fakeReader(many(2)));
    expect((await db.sql`select value from discovery.meta where key = 'registry_contract'`)[0].value).toBe(REGISTRY);
    expect((await run(fakeReader(many(2)))).status).toBe('ok');
  });

  it('a different contract id is a reset, even when the chain looks healthy', async () => {
    await reset();
    await run(fakeReader(many(3)));
    const before = await snapshot();
    const logs: Array<Record<string, string | number>> = [];
    const res = await run(fakeReader(many(9)), { registryId: 'C'.padEnd(56, 'A'), log: (e) => logs.push(e) });
    expect(res).toEqual({ added: 0, refreshed: 0, status: 'chain_reset' });
    expect(await snapshot()).toEqual(before);
    expect(logs).toEqual([{ event: 'registry_chain_reset', signal: 'contract_changed', total: 9, held_max: 2 }]);
  });

  it('an owner change of the newest agent is a legitimate transfer, not a reset', async () => {
    await reset();
    await run(fakeReader(many(3)));
    const other = Keypair.random().publicKey();
    const res = await run(fakeReader([agent(0), agent(1), agent(2, { owner: other })]));
    expect(res.status).toBe('ok');
    expect((await db.sql`select owner from discovery.agents where agent_id = 2`)[0].owner).toBe(other);
  });

  it('the highest held id missing on chain is a reset', async () => {
    await reset();
    await run(fakeReader(many(3)));
    const gone = fakeReader([agent(0), agent(1), null, agent(3), agent(4)]);
    expect((await run(gone)).status).toBe('chain_reset');
  });

  it('a transient failure of the highest-id probe does not halt', async () => {
    await reset();
    await run(fakeReader(many(3)));
    const reader = fakeReader(many(3));
    reader.fail = new Set([2]);
    expect((await run(reader)).status).toBe('ok');
  });

  it('without a registryId the contract signal is skipped', async () => {
    await reset();
    await run(fakeReader(many(2)));
    expect((await run(fakeReader(many(2)), { registryId: undefined })).status).toBe('ok');
  });
});
