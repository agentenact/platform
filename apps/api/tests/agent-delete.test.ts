import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Address, Asset, Contract, Keypair, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr, type Transaction } from '@stellar/stellar-sdk';
import { createAgents } from '../src/agents/index.js';
import { closeShape, buildMergeTx, buildSweepTx, feeBumpClose, SWEEP_CONTRACTS, CLOSE_MAX_FEE_STROOPS } from '../src/agents/close-tx.js';
import { createChatSessions } from '../src/chat/sessions.js';
import { createCloser, holdingsOf, MAX_ATTEMPTS, PURGE_AFTER_DAYS, type CloseChain, type Holdings } from '../src/agents/close.js';
import { createSponsorPolicy, policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { bindPreimage } from './support/entries.js';
import { contractAddress, insertUser } from './support/fixtures.js';
import { activeAgent, minimalSpec } from './support/specs.js';
import { createSpecs } from '../src/specs/index.js';

const P = TESTNET.passphrase;
const G = () => Keypair.random().publicKey();
/** A fresh contract (smart wallet) address: owner addresses are unique per user. */
const C = () => StrKey.encodeContract(randomBytes(32));
const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : ((e as { reason?: string } | null)?.reason ?? 'no error');
};

/** A sweep carrying the given auth entries (simulation would add the source-account one). */
function sweepWithAuth(from: string, to: string, auth: (ic: xdr.InvokeContractArgs) => xdr.SorobanAuthorizationEntry[], contract: string = SWEEP_CONTRACTS.usdc, source = from) {
  const op = new Contract(contract).call('transfer', new Address(from).toScVal(), new Address(to).toScVal(), nativeToScVal(5n, { type: 'i128' }));
  const func = (op.body().invokeHostFunctionOp() as xdr.InvokeHostFunctionOp).hostFunction();
  return new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: P })
    .addOperation(Operation.invokeHostFunction({ func, auth: auth(func.invokeContract()) }))
    .setTimeout(60)
    .build();
}
const entry = (ic: xdr.InvokeContractArgs, credentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount()) =>
  new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(ic), subInvocations: [] }),
  });

describe('close transaction shapes', () => {
  const agent = G();
  const owner = contractAddress(3);

  it('a sweep to the owner and a merge are close shapes', () => {
    expect(closeShape(buildSweepTx(new Account(agent, '1'), 'usdc', owner, 12_345n, P))).toMatchObject({ kind: 'sweep', agent, asset: 'usdc', to: owner, amount: 12_345n });
    expect(closeShape(buildSweepTx(new Account(agent, '1'), 'xlm', owner, 7n, P))).toMatchObject({ kind: 'sweep', asset: 'xlm' });
    const dest = G();
    expect(closeShape(buildMergeTx(new Account(agent, '1'), dest, P))).toMatchObject({ kind: 'merge', agent, destination: dest });
    expect(closeShape(sweepWithAuth(agent, owner, (ic) => [entry(ic)]))).toMatchObject({ kind: 'sweep' });
  });

  it('refuses anything else', () => {
    const b = () => new TransactionBuilder(new Account(agent, '1'), { fee: '200', networkPassphrase: P });
    // A payment, a merge of another trustline, a merge with an op source, no time bound.
    expect(closeShape(b().addOperation(Operation.payment({ destination: G(), asset: Asset.native(), amount: '1' })).setTimeout(60).build())).toBeNull();
    expect(closeShape(b().addOperation(Operation.changeTrust({ asset: new Asset('EVIL', G()), limit: '0' })).addOperation(Operation.accountMerge({ destination: G() })).setTimeout(60).build())).toBeNull();
    expect(closeShape(b().addOperation(Operation.changeTrust({ asset: new Asset('USDC', TESTNET.usdc.split(':')[1]!), limit: '0' })).addOperation(Operation.accountMerge({ destination: G(), source: G() })).setTimeout(60).build())).toBeNull();
    expect(closeShape(b().addOperation(Operation.changeTrust({ asset: new Asset('USDC', TESTNET.usdc.split(':')[1]!), limit: '0' })).addOperation(Operation.accountMerge({ destination: G() })).setTimeout(0).build())).toBeNull();
    // A transfer from someone else, from another contract, or with an entry that authorizes more than the source.
    expect(closeShape(sweepWithAuth(G(), owner, () => [], SWEEP_CONTRACTS.usdc, agent))).toBeNull();
    expect(closeShape(sweepWithAuth(agent, owner, () => [], contractAddress(9)))).toBeNull();
    const addressCreds = (ic: xdr.InvokeContractArgs) => [
      entry(ic, xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(G()).toScAddress(), nonce: new xdr.Int64(1), signatureExpirationLedger: 1, signature: xdr.ScVal.scvVoid() }))),
    ];
    expect(closeShape(sweepWithAuth(agent, owner, addressCreds))).toBeNull();
    // Over the fee cap.
    const pricey = new TransactionBuilder(new Account(agent, '1'), { fee: String(CLOSE_MAX_FEE_STROOPS + 1n), networkPassphrase: P })
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', TESTNET.usdc.split(':')[1]!), limit: '0' }))
      .setTimeout(60)
      .build();
    expect(closeShape(pricey)).toBeNull();
  });

  it('the sponsor pays for a close fee-bump and nothing that only looks like one', () => {
    const sponsor = Keypair.random();
    const policy = createSponsorPolicy({ sponsorPublicKey: sponsor.publicKey() });
    const inner = buildMergeTx(new Account(agent, '1'), G(), P);
    expect(policy.check(feeBumpClose(inner, sponsor.publicKey(), P).toXDR(), P).kind).toBe('close');
    // The sponsor's own account is never the one closed.
    expect(() => policy.check(feeBumpClose(buildMergeTx(new Account(sponsor.publicKey(), '1'), G(), P), sponsor.publicKey(), P).toXDR(), P)).toThrow();
    const pay = new TransactionBuilder(new Account(agent, '1'), { fee: '100', networkPassphrase: P })
      .addOperation(Operation.payment({ destination: G(), asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    expect(() => policy.check(TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), '1000', pay, P).toXDR(), P)).toThrow();
  });

  it('reads what Horizon says an account holds', () => {
    const usdc = { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: TESTNET.usdc.split(':')[1]!, balance: '1.2500000' };
    // A birth-sponsored account: zero minimum balance, so all its XLM may go.
    const sponsor = G();
    expect(holdingsOf({ sponsor, balances: [usdc, { asset_type: 'native', balance: '0.0000000' }], subentry_count: 1, num_sponsored: 3 })).toEqual({ usdc: 12_500_000n, xlm: 0n, blockers: 0, sponsored: true });
    expect(holdingsOf({ balances: [usdc, { asset_type: 'native', balance: '2.0000000' }], subentry_count: 1, num_sponsored: 3 })).toMatchObject({ xlm: 20_000_000n });
    // Its own reserves stay; another trustline blocks a merge.
    expect(holdingsOf({ balances: [usdc, { asset_type: 'credit_alphanum4', asset_code: 'X', asset_issuer: G(), balance: '0' }, { asset_type: 'native', balance: '3.0000000' }], subentry_count: 2 })).toEqual({
      usdc: 12_500_000n,
      xlm: 10_000_000n,
      blockers: 1,
      sponsored: false,
    });
  });
});

describe('deleting an agent', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  const sponsorKp = Keypair.random();
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
  });
  afterAll(() => drop());

  /** An active agent whose key is in the vault and was bound to `owner` (its user's owner address; the vault pins it). */
  async function agentWithKey(owner: string | null = C()) {
    const userId = await insertUser(sql, { ownerAddress: owner });
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id) values (${userId}, 'Scout', 'provisioning', '77') returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    if (owner) await keys.agentSigner(id, publicKey).signAuthEntry(bindPreimage(owner, publicKey));
    await sql`update app.agents set status = 'active' where id = ${id}`;
    await sql`update app.agents set stellar_address = ${publicKey} where id = ${id}`;
    return { userId, agentId: id, address: publicKey, owner };
  }
  const row = async (id: string) =>
    ((await sql`select status, deleted_at, close_state, close_attempts, close_error, close_txs, purged_at from app.agents where id = ${id}`) as {
      status: string;
      deleted_at: Date | null;
      close_state: string | null;
      close_attempts: number;
      close_error: string | null;
      close_txs: string[];
      purged_at: Date | null;
    }[])[0]!;

  it('marks the agent deleted, stops its triggers and drops its unsent seals; a second delete is the same answer', async () => {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: [{ kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' }] })));
    await sql`insert into app.check_seals (agent_id, check_at, document, digest) values (${a.agentId}, now(), '{}', ${randomBytes(32).toString('hex')})`;
    await createAgents(sql).remove(a.userId, a.agentId);
    const r = await row(a.agentId);
    expect(r).toMatchObject({ status: 'revoked', close_state: 'pending', close_attempts: 0 });
    expect(r.deleted_at).not.toBeNull();
    expect((await sql`select enabled from app.triggers where agent_id = ${a.agentId}`) as unknown).toEqual([{ enabled: false }]);
    expect((await sql`select status, error from app.check_seals where agent_id = ${a.agentId}`) as unknown).toEqual([{ status: 'failed', error: 'agent_deleted' }]);
    await createAgents(sql).remove(a.userId, a.agentId);
    expect((await row(a.agentId)).status).toBe('revoked');
  });

  it('frees the slot', async () => {
    const userId = await insertUser(sql, { ownerAddress: C() });
    const agents = createAgents(sql, { limits: { live: 1, perDay: 5 } });
    const first = await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
    await expect(agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409 });
    await agents.remove(userId, first.id);
    expect((await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID())).resumed).toBe(false);
  });

  it('refuses a foreign agent (404) and one being born on chain right now (409 busy)', async () => {
    const a = await activeAgent(sql);
    const stranger = await insertUser(sql);
    await expect(createAgents(sql).remove(stranger, a.agentId)).rejects.toMatchObject({ status: 404 });
    expect((await row(a.agentId)).status).toBe('active');
    await sql`update app.agents set status = 'provisioning', provision_state = '{"step": "creating", "attempts": []}' where id = ${a.agentId}`;
    await expect(createAgents(sql).remove(a.userId, a.agentId)).rejects.toMatchObject({ status: 409, code: 'busy' });
    await sql`update app.agents set provision_state = '{"step": "failed", "attempts": []}' where id = ${a.agentId}`;
    await createAgents(sql).remove(a.userId, a.agentId);
    expect((await row(a.agentId)).status).toBe('revoked');
  });

  describe('the vault signs a close only for a deleted agent, only to its owner', () => {
    it('refuses while the agent lives', async () => {
      const a = await agentWithKey();
      const tx = buildSweepTx(new Account(a.address, '1'), 'usdc', a.owner!, 10n, P);
      expect(await reasonOf(keys.signClose(a.agentId, tx.toXDR(), P))).toBe('not_deleted');
    });

    it('signs a sweep to the owner and a merge to the sponsor (owner is a contract wallet); nothing else', async () => {
      const a = await agentWithKey(C());
      await createAgents(sql).remove(a.userId, a.agentId);
      const sweep = buildSweepTx(new Account(a.address, '1'), 'usdc', a.owner!, 10n, P);
      const sig = await keys.signClose(a.agentId, sweep.toXDR(), P);
      expect(Keypair.fromPublicKey(a.address).verify(sweep.hash(), Buffer.from(sig, 'base64'))).toBe(true);
      expect(await reasonOf(keys.signClose(a.agentId, buildSweepTx(new Account(a.address, '1'), 'usdc', contractAddress(9), 10n, P).toXDR(), P))).toBe('wrong_owner');
      expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), sponsorKp.publicKey(), P).toXDR(), P))).toBe('no error');
      expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), G(), P).toXDR(), P))).toBe('wrong_owner');
      // Another account's close, a fee-bump, any other shape.
      expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(G(), '1'), sponsorKp.publicKey(), P).toXDR(), P))).toBe('wrong_wallet');
      expect(await reasonOf(keys.signClose(a.agentId, feeBumpClose(sweep, sponsorKp.publicKey(), P).toXDR(), P))).toBe('bad_payload');
      expect(await reasonOf(keys.signClose(a.agentId, sweep.toXDR(), 'Public Global Stellar Network ; September 2015'))).toBe('wrong_network');
      const n = (await sql`select count(*)::int as n from keyvault.signatures where agent_id = ${a.agentId} and kind = 'close'`) as { n: number }[];
      expect(n[0]!.n).toBe(2);
    });

    it('a G owner gets the merge too, the sponsor does not', async () => {
      const owner = G();
      const a = await agentWithKey(owner);
      await createAgents(sql).remove(a.userId, a.agentId);
      expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), owner, P).toXDR(), P))).toBe('no error');
      expect(await reasonOf(keys.signClose(a.agentId, buildMergeTx(new Account(a.address, '1'), sponsorKp.publicKey(), P).toXDR(), P))).toBe('wrong_owner');
    });
  });

  describe('the closer', () => {
    /** A chain that answers from a script of holdings and records what was submitted. */
    function fakeChain(script: (Holdings | null | Error)[]) {
      const sent: Transaction[] = [];
      const reads = [...script];
      const chain: CloseChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        getAccount: async (id) => new Account(id, String(10 + sent.length)),
        async holdings() {
          const next = reads.length > 1 ? reads.shift()! : reads[0]!;
          if (next instanceof Error) throw next;
          return next;
        },
        prepare: async (tx) => tx,
        signSponsor: (x, p) => policySponsor(sponsorKp).signTransaction(x, p),
        async submit(x) {
          const fb = TransactionBuilder.fromXDR(x, P);
          if (!('innerTransaction' in fb)) throw new Error('not a fee-bump');
          sent.push(fb.innerTransaction);
          return { hash: fb.hash().toString('hex') };
        },
      };
      return { chain, sent };
    }
    const events: Record<string, unknown>[] = [];
    const closerWith = (chain: CloseChain, k: Partial<AgentKeys> = {}, evm?: Parameters<typeof createCloser>[0]['evmBalance']) =>
      createCloser({ sql, chain, keys: { ...keys, ...k } as AgentKeys, evmBalance: evm, log: (e) => events.push(e) });

    it('sweeps USDC and XLM to the owner, merges, then destroys the key', async () => {
      const a = await agentWithKey(C());
      await createAgents(sql).remove(a.userId, a.agentId);
      const { chain, sent } = fakeChain([{ usdc: 25_000_000n, xlm: 3n, blockers: 0, sponsored: true }, { usdc: 0n, xlm: 0n, blockers: 0, sponsored: true }]);
      await closerWith(chain).close(a.agentId);
      expect(sent.map((t) => closeShape(t))).toMatchObject([
        { kind: 'sweep', asset: 'usdc', to: a.owner, amount: 25_000_000n },
        { kind: 'sweep', asset: 'xlm', to: a.owner, amount: 3n },
        { kind: 'merge', destination: sponsorKp.publicKey() },
      ]);
      const r = await row(a.agentId);
      expect(r).toMatchObject({ close_state: 'closed', close_error: null });
      expect(r.close_txs).toHaveLength(3);
      expect(await keys.publicKey(a.agentId)).toBeNull();
    });

    it('an account that is already gone only loses its key; a second close does nothing', async () => {
      const a = await agentWithKey();
      await createAgents(sql).remove(a.userId, a.agentId);
      const { chain, sent } = fakeChain([null]);
      await closerWith(chain).close(a.agentId);
      await closerWith(chain).close(a.agentId);
      expect(sent).toHaveLength(0);
      expect((await row(a.agentId)).close_state).toBe('closed');
      expect(await keys.publicKey(a.agentId)).toBeNull();
    });

    it('keeps every key while the EVM wallet holds something, and says so', async () => {
      const a = await agentWithKey();
      await createAgents(sql).remove(a.userId, a.agentId);
      const { chain } = fakeChain([null]);
      const evm = '0x' + '1'.repeat(40);
      await closerWith(chain, { evmAddress: async () => evm }, async () => ({ chain: 'base-sepolia', address: evm, exists: true, balances: [{ symbol: 'USDC', asset: 'x', amount: '0.5' }] })).close(a.agentId);
      expect(await row(a.agentId)).toMatchObject({ close_state: 'closed', close_error: 'evm_funds_kept' });
      expect(await keys.publicKey(a.agentId)).toBe(a.address);
    });

    it('reads every EVM testnet and the Solana wallet before the keys go: funds on any one of them keep every key', async () => {
      const evm = '0x' + '2'.repeat(40);
      const sol = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
      for (const [funded, note] of [['polygon-amoy', 'evm_funds_kept'], ['solana-devnet', 'solana_funds_kept']] as const) {
        const a = await agentWithKey();
        await createAgents(sql).remove(a.userId, a.agentId);
        const read: string[] = [];
        await closerWith(fakeChain([null]).chain, { evmAddress: async () => evm, solanaAddress: async () => sol }, async (q) => {
          read.push(q.chain);
          return { chain: q.chain, address: q.address, exists: true, balances: q.chain === funded ? [{ symbol: 'USDC', asset: 'x', amount: '0.1' }] : [] };
        }).close(a.agentId);
        expect(read).toEqual(funded === 'polygon-amoy' ? ['base-sepolia', 'arbitrum-sepolia', 'avalanche-fuji', 'polygon-amoy'] : ['base-sepolia', 'arbitrum-sepolia', 'avalanche-fuji', 'polygon-amoy', 'solana-devnet']);
        expect(await row(a.agentId)).toMatchObject({ close_state: 'closed', close_error: note });
        expect(await keys.publicKey(a.agentId)).toBe(a.address);
      }
      // All empty: the keys go.
      const a = await agentWithKey();
      await createAgents(sql).remove(a.userId, a.agentId);
      await closerWith(fakeChain([null]).chain, { evmAddress: async () => evm, solanaAddress: async () => sol }, async (q) => ({ chain: q.chain, address: q.address, exists: true, balances: [] })).close(a.agentId);
      expect(await row(a.agentId)).toMatchObject({ close_state: 'closed', close_error: null });
      expect(await keys.publicKey(a.agentId)).toBeNull();
    });

    it('never closes a live agent, and funds with no owner to receive them stay put', async () => {
      const live = await agentWithKey();
      const { chain, sent } = fakeChain([{ usdc: 1n, xlm: 0n, blockers: 0, sponsored: true }]);
      await closerWith(chain).close(live.agentId);
      expect(sent).toHaveLength(0);
      expect((await row(live.agentId)).close_state).toBeNull();

      const orphan = await agentWithKey(null);
      await createAgents(sql).remove(orphan.userId, orphan.agentId);
      await closerWith(chain).close(orphan.agentId);
      expect(sent).toHaveLength(0);
      expect(await row(orphan.agentId)).toMatchObject({ close_state: 'pending', close_error: 'no_owner', close_attempts: 1 });
      expect(await keys.publicKey(orphan.agentId)).toBe(orphan.address);
    });

    it('retries a failure later, gives up after MAX_ATTEMPTS and keeps the key', async () => {
      const a = await agentWithKey();
      await createAgents(sql).remove(a.userId, a.agentId);
      const { chain } = fakeChain([new Error('chain: Horizon submit failed: 503 ')]);
      const closer = closerWith(chain);
      await closer.close(a.agentId);
      expect(await row(a.agentId)).toMatchObject({ close_state: 'pending', close_error: 'horizon_503', close_attempts: 1 });
      // Not due yet: nothing runs.
      await closer.close(a.agentId);
      expect((await row(a.agentId)).close_attempts).toBe(1);
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        await sql`update app.agents set close_next_at = now() - interval '1 second' where id = ${a.agentId}`;
        await closer.close(a.agentId); // this agent only: other tests leave pending rows that would fill a tick's batch
      }
      expect(await row(a.agentId)).toMatchObject({ close_state: 'failed', close_attempts: MAX_ATTEMPTS });
      expect(await keys.publicKey(a.agentId)).toBe(a.address);
    });

    it('waits while the kill switch is on', async () => {
      const a = await agentWithKey();
      await createAgents(sql).remove(a.userId, a.agentId);
      const { chain } = fakeChain([null]);
      const closer = createCloser({ sql, chain, keys, killed: () => true, log: () => undefined });
      await closer.close(a.agentId);
      await closer.tick();
      expect((await row(a.agentId)).close_state).toBe('pending');
    });

    it(`clears private content ${PURGE_AFTER_DAYS} days after deletion and keeps the records`, async () => {
      const a = await activeAgent(sql);
      await sql`insert into app.memory (agent_id, key, value) values (${a.agentId}, 'note', 'secret')`;
      const runId = ((await sql`insert into app.runs (agent_id, mode, steps) values (${a.agentId}, 'chat', '[{"text":"hi"}]') returning id`) as { id: string }[])[0]!.id;
      const tx = randomBytes(32).toString('hex');
      await sql`insert into app.records (tx_hash, agent_id, run_id, record) values (${tx}, ${a.agentId}, ${runId}, '{}')`;
      const chats = createChatSessions(sql);
      const chat = await chats.create(a.userId, a.agentId);
      await chats.append(chat.id, { question: 'my balance?', answer: '12 XLM', status: 'done', runId: null });
      await createAgents(sql).remove(a.userId, a.agentId);
      const closer = createCloser({ sql, chain: fakeChain([null]).chain, keys, log: () => undefined });
      expect((await closer.tick()).purged).toBe(0); // too early
      await sql`update app.agents set deleted_at = now() - ${PURGE_AFTER_DAYS + 1} * interval '1 day' where id = ${a.agentId}`;
      expect((await closer.tick()).purged).toBeGreaterThanOrEqual(1);
      expect((await sql`select 1 from app.memory where agent_id = ${a.agentId}`) as unknown).toHaveLength(0);
      expect((await sql`select steps from app.runs where id = ${runId}`) as unknown).toEqual([{ steps: [] }]);
      expect((await sql`select tx_hash from app.records where agent_id = ${a.agentId}`) as unknown).toEqual([{ tx_hash: tx }]);
      expect((await row(a.agentId)).purged_at).not.toBeNull();
      // Chat words go, the turn's leaf (hashes only) stays for its seals.
      const [turn] = (await sql`select question, answer, leaf from app.chat_turns where session_id = ${chat.id}`) as { question: string; answer: string; leaf: string }[];
      expect([turn!.question, turn!.answer, turn!.leaf.length > 0]).toEqual(['', '', true]);
      expect((await sql`select title from app.chat_sessions where id = ${chat.id}`) as unknown).toEqual([{ title: null }]);
    });
  });
});
