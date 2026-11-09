import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb } from './support/db.js';

const TABLES = ['meta', 'agents', 'registry_events', 'payments', 'proven_sales', 'submissions', 'record_attempts', 'selfpub', 'services', 'hidden', 'feed'];
const G = (c: string) => `G${c.repeat(55)}`;

describe('discovery schema', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  it('creates every discovery table and the activity view', async () => {
    const rows = await sql`select table_name, table_type from information_schema.tables where table_schema = 'discovery'`;
    const names = rows.map((r: { table_name: string }) => r.table_name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(rows.find((r: { table_name: string }) => r.table_name === 'activity')?.table_type).toBe('VIEW');
  });

  it('the activity view names payment and sale rows received, sent and sale (the "active" rule depends on these)', async () => {
    const t = '9'.repeat(64);
    await sql`insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payer_agent_id, payee, amount_units, asset, at, counted)
      values ('opk', 0, 71, ${t}, ${G('P')}, 72, ${G('W')}, 10000, 'USDC:X', now(), true)`;
    await sql`insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at)
      values (${t}, ${G('S')}, 73, 'dk', '{}', 'hosted', ${G('P')}, 10000, 'USDC:X', now())`;
    await sql`insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at) values ('ek', 74, 'registered', ${t}, 1, now())`;
    const rows = await sql`select agent_id, kind from discovery.activity where agent_id between 71 and 74 order by agent_id`;
    expect(rows.map((r: { agent_id: number; kind: string }) => `${r.agent_id}:${r.kind}`)).toEqual(['71:received', '72:sent', '73:sale', '74:registered']);
    await sql`delete from discovery.payments where op_id = 'opk'`;
    await sql`delete from discovery.proven_sales where digest = 'dk'`;
    await sql`delete from discovery.registry_events where event_id = 'ek'`;
  });

  it('tracked_wallet is the wallet whenever it is set, equal to the owner or not', async () => {
    await sql`insert into discovery.agents (agent_id, owner, wallet, source) values (1, ${G('A')}, ${G('A')}, 'event'), (2, ${G('B')}, ${G('C')}, 'event'), (3, ${G('D')}, null, 'event')`;
    const rows = await sql`select tracked_wallet from discovery.agents where agent_id in (1, 2, 3) order by agent_id`;
    expect(rows.map((r: { tracked_wallet: string | null }) => r.tracked_wallet)).toEqual([G('A'), G('C'), null]);
  });

  it('agents.updated_at moves when owner, wallet or uri change and not for other columns', async () => {
    await sql`insert into discovery.agents (agent_id, owner, source) values (9, ${G('A')}, 'event')`;
    const stamp = async () => (await sql`select updated_at::text as t from discovery.agents where agent_id = 9`)[0]?.t as string;
    const t0 = await stamp();
    await sql`update discovery.agents set payments_cursor = 'c', last_active_at = now(), builder = 'library' where agent_id = 9`;
    expect(await stamp()).toBe(t0);
    await sql`update discovery.agents set uri = 'x' where agent_id = 9`;
    const t1 = await stamp();
    expect(t1).not.toBe(t0);
    await sql`update discovery.agents set wallet = ${G('B')} where agent_id = 9`;
    const t2 = await stamp();
    expect(t2).not.toBe(t1);
    await sql`update discovery.agents set owner = ${G('C')} where agent_id = 9`;
    expect(await stamp()).not.toBe(t2);
  });

  it('the indexer role cannot read keyvault.keys or app.agents', async () => {
    for (const table of ['keyvault.keys', 'app.agents']) {
      const attempt = sql.begin(async (tx) => {
        await tx.unsafe('set local role discovery_indexer');
        await tx.unsafe('select 1 from discovery.meta'); // control: the role switch itself works
        await tx.unsafe(`select 1 from ${table}`);
      });
      // Denied at the schema (vault, or app with no app.records yet) or at the table (0008 grants schema usage for app.records only).
      await expect(Promise.resolve(attempt)).rejects.toMatchObject({ errno: '42501', message: expect.stringMatching(/^permission denied for (schema (app|keyvault)|table agents)$/) });
    }
  });

  it('the indexer role can read app.records only, write nothing in app, and touch no other app table', async () => {
    const [row] = (await sql`select to_regclass('app.records') is not null as exists`) as { exists: boolean }[];
    const exists = row?.exists ?? false;
    const [schema] = await sql`select has_schema_privilege('discovery_indexer', 'app', 'USAGE') as usage`;
    expect(schema?.usage).toBe(exists); // 0008 grants usage only for app.records
    const tables = await sql`select tablename from pg_tables where schemaname = 'app'`;
    expect(tables.length).toBeGreaterThan(0);
    for (const { tablename } of tables as { tablename: string }[]) {
      const [p] = await sql`select has_table_privilege('discovery_indexer', ${`app."${tablename}"`}, 'SELECT') as sel, has_table_privilege('discovery_indexer', ${`app."${tablename}"`}, 'INSERT') as ins`;
      expect({ tablename, sel: p?.sel, ins: p?.ins }).toEqual({ tablename, sel: tablename === 'records', ins: false });
    }
  });

  it('the indexer role can write discovery tables', async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role discovery_indexer');
      await tx.unsafe(`insert into discovery.meta (key, value) values ('network', 'testnet')`);
    });
    const [row] = await sql`select value from discovery.meta where key = 'network'`;
    expect(row?.value).toBe('testnet');
  });

  it('payments rejects non-positive amounts and a feed source_key is unique', async () => {
    const pay = (amount: number) =>
      sql`insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payee, amount_units, asset, at, counted)
          values ('op', 0, 1, 'tx', ${G('D')}, ${G('A')}, ${amount}, 'USDC', now(), true)`;
    await expect(Promise.resolve(pay(0))).rejects.toMatchObject({ errno: '23514' });
    await sql`insert into discovery.feed (kind, agent_id, at, source_key) values ('registered', 1, now(), 'k1')`;
    await expect(Promise.resolve(sql`insert into discovery.feed (kind, agent_id, at, source_key) values ('registered', 1, now(), 'k1')`)).rejects.toMatchObject({ errno: '23505' });
  });

  it('registry_events accepts every decoded kind (incl. owner_changed) and rejects others', async () => {
    const ins = (id: string, kind: string) =>
      sql`insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at) values (${id}, 1, ${kind}, 'tx', 1, now())`;
    for (const kind of ['registered', 'uri_updated', 'wallet_bound', 'owner_changed']) await ins(`e-${kind}`, kind);
    await expect(Promise.resolve(ins('e-bad', 'mint'))).rejects.toMatchObject({ errno: '23514' });
  });
});

describe('discovery indexer role limits (0012)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  it('caps connections and bounds statements and idle transactions', async () => {
    const [r] = await sql`select rolconnlimit, rolconfig from pg_roles where rolname = 'discovery_indexer'`;
    expect(r.rolconnlimit).toBe(10);
    expect(r.rolconfig).toContain('statement_timeout=30s');
    expect(r.rolconfig).toContain('idle_in_transaction_session_timeout=60s');
  });

  it('a discovery table added by a later migration is usable by the indexer without a new grant', async () => {
    await sql`create table discovery.later_table (id bigserial primary key, v text)`;
    const [r] = await sql`select has_table_privilege('discovery_indexer', 'discovery.later_table', 'INSERT') as ins,
                                 has_sequence_privilege('discovery_indexer', 'discovery.later_table_id_seq', 'USAGE') as seq`;
    expect(r).toEqual({ ins: true, seq: true });
  });

  it('is re-runnable', async () => {
    const text = await Bun.file(new URL('../../../migrations/0012_discovery_indexer_limits.sql', import.meta.url).pathname).text();
    await sql.unsafe(text);
    expect((await sql`select rolconnlimit from pg_roles where rolname = 'discovery_indexer'`)[0].rolconnlimit).toBe(10);
  });
});

describe('discovery records grant (0008)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  const grantFile = new URL('../../../migrations/0008_discovery_records_grant.sql', import.meta.url).pathname;
  const asIndexer = (query: string) =>
    Promise.resolve(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role discovery_indexer');
        return tx.unsafe(query);
      }),
    );

  it('the indexer role can select app.records and nothing else in app', async () => {
    // P4's table (migration 0005), as a stand-in with the same columns and no foreign keys.
    await sql.unsafe(`create table if not exists app.records (tx_hash text primary key, agent_id uuid not null, run_id uuid, record jsonb not null, created_at timestamptz not null default now())`);
    await sql.unsafe(await Bun.file(grantFile).text());
    // The real table (migration 0005) references app.agents, so the row needs a real agent.
    const [u] = (await sql`insert into app.users (id, email) values (gen_random_uuid(), 'grant@example.com') returning id`) as { id: string }[];
    const [a] = (await sql`insert into app.agents (user_id, name) values (${u!.id}, 'grant') returning id`) as { id: string }[];
    await sql.unsafe(`insert into app.records (tx_hash, agent_id, record) values ('${'a'.repeat(64)}', '${a!.id}', '{}')`);

    expect(((await asIndexer('select tx_hash, record from app.records')) as unknown[]).length).toBe(1);
    await expect(asIndexer(`insert into app.records (tx_hash, agent_id, record) values ('x', gen_random_uuid(), '{}')`)).rejects.toMatchObject({ errno: '42501' });
    await expect(asIndexer('update app.records set record = \'{}\'')).rejects.toMatchObject({ errno: '42501' });
    for (const table of ['keyvault.keys', 'app.agents']) await expect(asIndexer(`select 1 from ${table}`)).rejects.toMatchObject({ errno: '42501', message: expect.stringMatching(/permission denied for (table|schema keyvault)/) });
    const tables = (await sql`select tablename from pg_tables where schemaname = 'app' and tablename <> 'records'`) as { tablename: string }[];
    expect(tables.length).toBeGreaterThan(0);
    for (const { tablename } of tables) {
      const [p] = await sql`select has_table_privilege('discovery_indexer', ${`app."${tablename}"`}, 'SELECT') as sel`;
      expect({ tablename, sel: p?.sel }).toEqual({ tablename, sel: false });
    }
  });

  it('is a no-op while app.records does not exist', async () => {
    const fresh = await freshDb();
    try {
      // A fresh database has every migration, so take app.records and its grant away first.
      await fresh.sql.unsafe('revoke usage on schema app from discovery_indexer; drop table app.records cascade');
      await fresh.sql.unsafe(await Bun.file(grantFile).text());
      const [schema] = await fresh.sql`select has_schema_privilege('discovery_indexer', 'app', 'USAGE') as usage`;
      expect(schema?.usage).toBe(false);
    } finally {
      await fresh.drop();
    }
  });
});
