import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Keypair, StrKey } from '@stellar/stellar-sdk';
import { createAgents } from '../src/agents/index.js';
import { buildMergeTx, buildSweepTx } from '../src/agents/close-tx.js';
import { policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { bindPreimage } from './support/entries.js';
import { insertUser } from './support/fixtures.js';

const P = TESTNET.passphrase;
const G = () => Keypair.random().publicKey();
const C = () => StrKey.encodeContract(randomBytes(32));
const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : 'no error';
};

/**
 * The api's database role can write app.users.owner_address and app.agents.user_id. An api that is taken over must
 * still not be able to point a deleted agent's sweep (or merge) at an address of its own.
 */
describe('a taken-over api cannot redirect a close', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(Keypair.random()) }));
  });
  afterAll(() => drop());

  /** As the api role: what a compromised api process can do with its own credentials. */
  const asApi = (q: (tx: Db) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`set local role agentenact_api`;
      await q(tx as unknown as Db);
    });

  /** Born and bound to `owner` (the vault pins it at bind), then deleted by its owner. `bind: false` = never bound. */
  async function deletedAgent(owner: string, o: { bind?: boolean } = {}) {
    const userId = await insertUser(sql, { ownerAddress: owner });
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id) values (${userId}, 'Scout', 'provisioning', '77') returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    if (o.bind !== false) await keys.agentSigner(id, publicKey).signAuthEntry(bindPreimage(owner, publicKey));
    await sql`update app.agents set status = 'active' where id = ${id}`;
    await createAgents(sql).remove(userId, id);
    return { userId, agentId: id, address: publicKey };
  }

  it('rewriting the owner address does not move the sweep', async () => {
    const a = await deletedAgent(C());
    const thief = C();
    await asApi((tx) => tx`update app.users set owner_address = ${thief} where id = ${a.userId}`);
    expect(await reasonOf(keys.signClose(a.agentId, buildSweepTx(new Account(a.address, '1'), 'usdc', thief, 10n, P).toXDR(), P))).toBe('wrong_owner');
  });

  it('moving the agent to another user does not move the sweep', async () => {
    const a = await deletedAgent(C());
    const thief = C();
    const other = await insertUser(sql, { ownerAddress: thief });
    await asApi((tx) => tx`update app.agents set user_id = ${other} where id = ${a.agentId}`);
    expect(await reasonOf(keys.signClose(a.agentId, buildSweepTx(new Account(a.address, '1'), 'xlm', thief, 10n, P).toXDR(), P))).toBe('wrong_owner');
  });

  it('the real owner still gets the sweep after a rewrite', async () => {
    const owner = C();
    const a = await deletedAgent(owner);
    await asApi((tx) => tx`update app.users set owner_address = ${C()} where id = ${a.userId}`);
    expect(await reasonOf(keys.signClose(a.agentId, buildSweepTx(new Account(a.address, '1'), 'usdc', owner, 10n, P).toXDR(), P))).toBe('no error');
  });

  it('a pinned owner never moves: a second bind to another owner is refused', async () => {
    const owner = C();
    const userId = await insertUser(sql, { ownerAddress: owner });
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id) values (${userId}, 'Scout', 'provisioning', '77') returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    const signer = keys.agentSigner(id, publicKey);
    await signer.signAuthEntry(bindPreimage(owner, publicKey));
    await signer.signAuthEntry(bindPreimage(owner, publicKey)); // a retry of the same bind is fine
    const thief = C();
    await asApi((tx) => tx`update app.users set owner_address = ${thief} where id = ${userId}`);
    expect(await reasonOf(signer.signAuthEntry(bindPreimage(thief, publicKey)))).toBe('wrong_owner');
    expect((await sql`select owner_address from keyvault.keys where agent_id = ${id}`) as unknown).toEqual([{ owner_address: owner }]);
  });

  it('a never-bound agent gets no sweep; its merge goes only to the sponsor', async () => {
    const owner = G();
    const a = await deletedAgent(owner, { bind: false });
    expect(await reasonOf(keys.signClose(a.agentId, buildSweepTx(new Account(a.address, '1'), 'xlm', owner, 10n, P).toXDR(), P))).toBe('wrong_owner');
    expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), owner, P).toXDR(), P))).toBe('wrong_owner');
    expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), await keys.sponsorPublicKey(), P).toXDR(), P))).toBe('no error');
  });

  it('rewriting a G owner does not move the merge', async () => {
    const a = await deletedAgent(G());
    const thief = G();
    await asApi((tx) => tx`update app.users set owner_address = ${thief} where id = ${a.userId}`);
    expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), thief, P).toXDR(), P))).toBe('wrong_owner');
  });
});
