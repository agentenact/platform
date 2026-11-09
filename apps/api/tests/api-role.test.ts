import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDb, dbRole, type Db } from '../src/db/index.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const MIGRATION = new URL('../../../migrations/0020_api_role.sql', import.meta.url).pathname;
const PASSWORD = 'api-role-test';

const errnoOf = (p: PromiseLike<unknown>) =>
  Promise.resolve(p).then(
    () => 'ok',
    (e: unknown) => (e as { errno?: string }).errno ?? String(e),
  );

describe('api role (migration 0020)', () => {
  let sql: Db;
  let asApi: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDb();
    ({ sql, drop } = fresh);
    // Roles are cluster-wide; this is the test cluster (freshDb refuses any other).
    await sql.unsafe(`alter role agentenact_api login password '${PASSWORD}'`);
    const url = new URL(fresh.url);
    url.username = 'agentenact_api';
    url.password = PASSWORD;
    asApi = createDb(url.toString());
  });
  afterAll(async () => {
    await asApi?.close();
    await sql.unsafe('alter role agentenact_api nologin password null');
    await drop();
  });

  it('holds no role attribute or membership that reaches past its grants', async () => {
    const [r] = await sql`select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication,
                                 (select count(*)::int from pg_auth_members where member = 'agentenact_api'::regrole) as memberships
                          from pg_roles where rolname = 'agentenact_api'`;
    expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false, memberships: 0 });
  });

  it('reads and writes every table in app and discovery, and nothing in keyvault', async () => {
    const rows = (await sql`select n.nspname as schema, c.relname as name,
                                   has_table_privilege('agentenact_api', c.oid, 'SELECT, INSERT, UPDATE, DELETE') as dml,
                                   has_table_privilege('agentenact_api', c.oid, 'SELECT') as reads
                            from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname in ('app', 'discovery', 'keyvault') and c.relkind in ('r', 'v', 'p')
                            order by 1, 2`) as { schema: string; name: string; dml: boolean; reads: boolean }[];
    expect(rows.filter((r) => r.schema === 'keyvault').length).toBe(3);
    for (const r of rows) {
      const allowed = r.schema !== 'keyvault';
      expect(r).toEqual({ ...r, dml: allowed, reads: allowed });
    }
  });

  it('works through its own login, and is refused the vault', async () => {
    const userId = await insertUser(asApi);
    const id = await insertAgent(asApi, userId, { status: 'active' });
    await asApi`update app.agents set agent_id = '7' where id = ${id}`;
    await asApi`insert into discovery.submissions (digest, record) values (${'a'.repeat(64)}, ${{ v: '0.1' }})`;
    expect((await asApi`select id from app.agents where id = ${id}`).length).toBe(1);
    for (const q of [
      'select 1 from keyvault.keys',
      'select 1 from keyvault.sponsor_signatures',
      'set role agentenact_vault',
      "alter role agentenact_vault password 'x'",
      'create role sneaky',
    ])
      expect({ q, errno: await errnoOf(asApi.unsafe(q)) }).toEqual({ q, errno: '42501' });
  });

  it('its boot log names it and says it cannot read the keys, and flags a stray grant on them', async () => {
    expect(await dbRole(asApi)).toEqual({ role: 'agentenact_api', superuser: false, reads_keys: false });
    await sql.unsafe('grant select on keyvault.keys to agentenact_api');
    try {
      expect((await dbRole(asApi)).reads_keys).toBe(true);
    } finally {
      await sql.unsafe('revoke select on keyvault.keys from agentenact_api');
    }
  });

  it('re-runs as a role without superuser, as servel migrates (postgres there has CREATEROLE but not SUPERUSER)', async () => {
    await sql.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'migrator_stand_in') then
                        create role migrator_stand_in nologin nosuperuser createrole; end if; end $$`);
    // The test cluster's postgres is no superuser either: SET ROLE needs the membership.
    await sql.unsafe('grant migrator_stand_in to current_user');
    await sql.unsafe(`grant usage on schema app, discovery to migrator_stand_in with grant option;
                      grant all on all tables in schema app, discovery to migrator_stand_in with grant option;
                      grant all on all sequences in schema app, discovery to migrator_stand_in with grant option;
                      grant all on all functions in schema app, discovery to migrator_stand_in with grant option;
                      grant usage on schema keyvault to migrator_stand_in`); // as postgres, which created keyvault (0018)
    const migration = await Bun.file(MIGRATION).text();
    const run = sql.begin(async (tx) => {
      await tx.unsafe('set local role migrator_stand_in');
      await tx.unsafe(migration);
    });
    // The message, not just the errno: a refusal here names the statement servel would stop at.
    expect(await Promise.resolve(run).then(() => 'ok', (e: Error) => e.message)).toBe('ok');
  });

  it('gets the same on tables a later migration creates', async () => {
    await sql.unsafe('create table app.later_table (id int primary key); create sequence app.later_seq');
    const [r] = await sql`select has_table_privilege('agentenact_api', 'app.later_table', 'SELECT, INSERT, UPDATE, DELETE') as dml,
                                 has_sequence_privilege('agentenact_api', 'app.later_seq', 'USAGE') as seq`;
    expect(r).toEqual({ dml: true, seq: true });
  });
});
