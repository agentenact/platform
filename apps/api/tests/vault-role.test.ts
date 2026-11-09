import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, hash, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { buildCreditTx } from '../src/agents/credit-tx.js';
import { policySponsor } from '../src/chain/sponsor.js';
import { createDb, type Db } from '../src/db/index.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { invocation, scv } from './support/entries.js';
import { insertAgent, insertUser } from './support/fixtures.js';
import { walletDeployTx } from './support/sponsor-txs.js';

const MIGRATION = new URL('../../../migrations/0018_vault_role.sql', import.meta.url).pathname;
const PASSWORD = 'vault-role-test';

const transfer = (from: string, to: string, amount: bigint) =>
  xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(TESTNET.passphrase)),
      nonce: new xdr.Int64(Math.floor(Math.random() * 1e9)),
      signatureExpirationLedger: 5000,
      invocation: invocation(TESTNET.usdcSac, 'transfer', [scv.addr(from), scv.addr(to), scv.i128(amount)]),
    }),
  ).toXDR('base64');

const errnoOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { errno?: string }).errno ?? String(e));

describe('vault role (migrations 0018, 0019)', () => {
  let sql: Db;
  let asVault: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDb();
    ({ sql, drop } = fresh);
    // Roles are cluster-wide; this is the test cluster (freshDb refuses any other).
    await sql.unsafe(`alter role agentenact_vault login password '${PASSWORD}'`);
    const url = new URL(fresh.url);
    url.username = 'agentenact_vault';
    url.password = PASSWORD;
    asVault = createDb(url.toString());
  });
  afterAll(async () => {
    await asVault?.close();
    await sql.unsafe('alter role agentenact_vault nologin password null');
    await drop();
  });

  /** A role holding everything schema app hands out, as postgres does on servel (every migration's closing grant). */
  const asApi = async (query: string) =>
    errnoOf(
      Promise.resolve(
        sql.begin(async (tx) => {
          await tx.unsafe('set local role api_stand_in');
          return tx.unsafe(query);
        }),
      ),
    );

  it('moves the keys and the signing ledger out of schema app', async () => {
    const rows = (await sql`select table_schema, table_name from information_schema.tables
                            where table_name in ('keys', 'signatures', 'vault_signatures') order by table_name`) as { table_schema: string; table_name: string }[];
    expect(rows.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual(['keyvault.keys', 'keyvault.signatures']);
  });

  it('a role with every app grant cannot read or write the vault tables, even after a stray grant and a re-run', async () => {
    await sql.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'api_stand_in') then create role api_stand_in nologin; end if; end $$`);
    // The test cluster's postgres is no superuser (as on servel): SET ROLE needs the membership.
    await sql.unsafe('grant api_stand_in to current_user');
    await sql.unsafe(`grant usage on schema app to api_stand_in; grant select, insert, update, delete on all tables in schema app to api_stand_in`);
    await sql.unsafe(`grant usage on schema keyvault to api_stand_in; grant select on keyvault.keys to api_stand_in; grant select on keyvault.signatures to public`);
    expect(await asApi('select 1 from keyvault.keys')).toBe('ok'); // control: the stray grant took
    await sql.unsafe(await Bun.file(MIGRATION).text());
    for (const q of ['select 1 from keyvault.keys', 'select 1 from keyvault.signatures', 'select 1 from keyvault.sponsor_signatures', "update keyvault.keys set public_key = 'G'", 'delete from keyvault.signatures'])
      expect(await asApi(q)).toBe('42501');
    expect(await asApi('select 1 from app.agents')).toBe('ok'); // and the api keeps its own tables
  });

  it('the vault role signs through its own connection: keys, records and capped payments', async () => {
    const owner = StrKey.encodeContract(randomBytes(32));
    const id = await insertAgent(sql, await insertUser(sql, { ownerAddress: owner }), { status: 'active' });
    await sql`update app.agents set agent_id = '77' where id = ${id}`;
    const sponsorKp = Keypair.random();
    const keys = localAgentKeys(createVault({ sql: asVault, keys: createKeys(asVault, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
    await keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(walletDeployTx(sponsorKp.publicKey()).toXDR(), TESTNET.passphrase);
    const { publicKey } = await keys.generate(id);
    expect(await keys.publicKey(id)).toBe(publicKey);
    const pre = transfer(publicKey, Keypair.random().publicKey(), 1_000n);
    const s = await keys.paySigner(id, publicKey).signAuthEntry(pre);
    expect(Keypair.fromPublicKey(publicKey).verify(hash(Buffer.from(pre, 'base64')), Buffer.from(s.signedAuthEntry, 'base64'))).toBe(true);
    await keys.destroy(id);
    expect(await keys.publicKey(id)).toBeNull();
  });

  it('the vault role signs a testnet credit through its own connection (it reads app.agents.deleted_at)', async () => {
    const id = await insertAgent(sql, await insertUser(sql, { ownerAddress: StrKey.encodeContract(randomBytes(32)) }), { status: 'active' });
    const sponsorKp = Keypair.random();
    const keys = localAgentKeys(createVault({ sql: asVault, keys: createKeys(asVault, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
    const { publicKey } = await keys.generate(id);
    const credit = buildCreditTx(new Account(sponsorKp.publicKey(), '1'), publicKey, 20_000_000n, [], TESTNET.passphrase).toXDR();
    expect(await errnoOf(keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(credit, TESTNET.passphrase))).toBe('ok');
  });

  it('the vault role reads the operator limits (migration 0049): a credit cap of 0 refuses the credit', async () => {
    const id = await insertAgent(sql, await insertUser(sql, { ownerAddress: StrKey.encodeContract(randomBytes(32)) }), { status: 'active' });
    const sponsorKp = Keypair.random();
    const keys = localAgentKeys(createVault({ sql: asVault, keys: createKeys(asVault, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
    const { publicKey } = await keys.generate(id);
    await sql`insert into app.ops_settings (key, value, updated_by) values ('vault_credits_per_day', '0', 'test')`;
    try {
      const credit = buildCreditTx(new Account(sponsorKp.publicKey(), '1'), publicKey, 20_000_000n, [], TESTNET.passphrase).toXDR();
      const reason = await keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(credit, TESTNET.passphrase).then(() => 'ok', (e: unknown) => (e as { reason?: string }).reason ?? String(e));
      expect(reason).toBe('over_day_cap');
    } finally {
      await sql`delete from app.ops_settings`;
    }
    expect(await errnoOf(Promise.resolve(asVault.unsafe("insert into app.ops_settings (key, value, updated_by) values ('vault_credits_per_day', '50', 'x')")))).toBe('42501');
    expect(await errnoOf(Promise.resolve(asVault.unsafe("update app.ops_settings set value = '50'")))).toBe('42501');
  });

  it('the vault role sees only what it checks in app, and changes nothing there or in its own ledger', async () => {
    const q = (query: string) => errnoOf(Promise.resolve(asVault.unsafe(query)));
    expect(await q('select id, user_id, status, agent_id from app.agents')).toBe('ok');
    expect(await q('select id, owner_address from app.users')).toBe('ok');
    for (const denied of [
      'select email from app.users',
      'select name from app.agents',
      'select 1 from app.runs',
      'select 1 from app.spend',
      "update app.agents set status = 'active'",
      'delete from keyvault.signatures',
      'update keyvault.signatures set amount_units = 1',
      'delete from keyvault.keys',
      'delete from keyvault.sponsor_signatures',
    ])
      expect({ denied, errno: await q(denied) }).toEqual({ denied, errno: '42501' });
  });
});
