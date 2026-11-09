import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Asset, Keypair, Memo, Operation, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { createAgents } from '../src/agents/index.js';
import { createTestnetCredits, CREDIT_FLOOR_UNITS, type CreditChain } from '../src/agents/credit.js';
import { buildCreditTx, CREDIT_MAX_FEE_STROOPS, CREDIT_MAX_SEND_STROOPS, creditShape } from '../src/agents/credit-tx.js';
import { createSponsorPolicy, policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault, VAULT_CREDITS_PER_DAY, VAULT_CREDIT_EVERY_H } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { insertUser } from './support/fixtures.js';

const P = TESTNET.passphrase;
const G = () => Keypair.random().publicKey();
const C = () => StrKey.encodeContract(randomBytes(32));
const USDC = new Asset(...(TESTNET.usdc.split(':') as [string, string]));
const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : ((e as { reason?: string } | null)?.reason ?? 'no error');
};

describe('credit transaction shape', () => {
  const sponsor = Keypair.random().publicKey();
  const agent = G();
  const b = (fee = '1000') => new TransactionBuilder(new Account(sponsor, '1'), { fee, networkPassphrase: P });
  const swap = (o: Partial<Parameters<typeof Operation.pathPaymentStrictReceive>[0]> = {}) =>
    Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '2', destination: agent, destAsset: USDC, destAmount: '1', path: [], ...o });

  it('the sponsor buying exactly 1 USDC for one agent is a credit', () => {
    expect(creditShape(buildCreditTx(new Account(sponsor, '1'), agent, 20_000_000n, [], P))).toEqual({ sponsor, agent, sendMaxStroops: 20_000_000n });
    expect(creditShape(b().addOperation(swap({ path: [new Asset('yXLM', G())] })).setTimeout(60).build())).toMatchObject({ agent });
    expect(() => buildCreditTx(new Account(sponsor, '1'), agent, CREDIT_MAX_SEND_STROOPS + 1n, [], P)).toThrow();
    expect(() => buildCreditTx(new Account(sponsor, '1'), sponsor, 1n, [], P)).toThrow();
  });

  it('refuses anything else', () => {
    // Another amount, another asset, paid in something other than XLM, over the XLM cap, to the sponsor itself.
    expect(creditShape(b().addOperation(swap({ destAmount: '1.0000001' })).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap({ destAsset: new Asset('USDC', G()) })).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap({ sendAsset: USDC })).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap({ sendMax: '20.0000001' })).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap({ destination: sponsor })).setTimeout(60).build())).toBeNull();
    // Sourced by another account (spending someone else's XLM), an extra op, no time bound, a memo, over the fee cap.
    expect(creditShape(b().addOperation(swap({ source: G() })).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap()).addOperation(swap()).setTimeout(60).build())).toBeNull();
    expect(creditShape(b().addOperation(swap()).setTimeout(0).build())).toBeNull();
    expect(creditShape(b().addOperation(swap()).addMemo(Memo.text('x')).setTimeout(60).build())).toBeNull();
    expect(creditShape(b(String(CREDIT_MAX_FEE_STROOPS + 1n)).addOperation(swap()).setTimeout(60).build())).toBeNull();
  });

  it('the sponsor policy signs a credit it sources, never one another account sources, and names the agent', () => {
    const kp = Keypair.random();
    const policy = createSponsorPolicy({ sponsorPublicKey: kp.publicKey() });
    const mine = buildCreditTx(new Account(kp.publicKey(), '1'), agent, 20_000_000n, [], P);
    expect(policy.check(mine.toXDR(), P)).toMatchObject({ kind: 'credit', creditTo: agent });
    const theirs = buildCreditTx(new Account(G(), '1'), agent, 20_000_000n, [], P);
    expect(() => policy.check(theirs.toXDR(), P)).toThrow();
    expect(() => policy.check(mine.toXDR(), 'Public Global Stellar Network ; September 2015')).toThrow();
  });
});

describe('testnet credits', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  const sponsorKp = Keypair.random();
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
  });
  afterAll(() => drop());

  async function agentWithKey(reserve: 'free' | 'due' | 'self_paid' = 'free') {
    const uid = await insertUser(sql, { ownerAddress: C() });
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id, reserve_state) values (${uid}, 'Scout', 'active', '77', ${reserve}) returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    await sql`update app.agents set stellar_address = ${publicKey} where id = ${id}`;
    return { userId: uid, agentId: id, address: publicKey };
  }
  const credit = (to: string) => buildCreditTx(new Account(sponsorKp.publicKey(), '1'), to, 20_000_000n, [], P).toXDR();
  const sponsorSign = (x: string) => keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(x, P);

  describe('the vault signs a credit', () => {
    it('for a live agent once per spacing, never for a stranger, an agent whose reserves are due, or a deleted one', async () => {
      const a = await agentWithKey();
      expect(await reasonOf(sponsorSign(credit(a.address)))).toBe('no error');
      expect(await reasonOf(sponsorSign(credit(a.address)))).toBe('over_day_cap');
      expect(await reasonOf(sponsorSign(credit(G())))).toBe('not_active');
      const due = await agentWithKey('due');
      expect(await reasonOf(sponsorSign(credit(due.address)))).toBe('not_active');
      const gone = await agentWithKey('self_paid');
      await createAgents(sql).remove(gone.userId, gone.agentId);
      expect(await reasonOf(sponsorSign(credit(gone.address)))).toBe('not_active');
    });

    it('a credit that never reached the agent blocks the next one for hours, not a day', async () => {
      const a = await agentWithKey();
      expect(await reasonOf(sponsorSign(credit(a.address)))).toBe('no error');
      expect(await reasonOf(sponsorSign(credit(a.address)))).toBe('over_day_cap');
      await sql`update keyvault.signatures set at = at - ${VAULT_CREDIT_EVERY_H} * interval '1 hour' where agent_id = ${a.agentId} and kind = 'credit'`;
      expect(await reasonOf(sponsorSign(credit(a.address)))).toBe('no error');
      expect(VAULT_CREDIT_EVERY_H).toBeLessThanOrEqual(2);
    });

    it('at most VAULT_CREDITS_PER_DAY in a day, all agents together', async () => {
      await sql`delete from keyvault.signatures where kind = 'credit'`;
      const fresh = await agentWithKey();
      await sql`insert into keyvault.signatures (agent_id, kind, digest)
                select ${fresh.agentId}::uuid, 'credit', encode(sha256(g::text::bytea), 'hex') from generate_series(1, ${VAULT_CREDITS_PER_DAY}) g`;
      // Those rows are this agent's own; a second agent shows the day total alone refuses.
      const other = await agentWithKey();
      expect(await reasonOf(sponsorSign(credit(other.address)))).toBe('over_day_cap');
    });
  });

  describe('the worker', () => {
    function fakeChain(o: { usdc: bigint | null; quote?: bigint | null; fail?: Error }) {
      const sent: Transaction[] = [];
      const chain: CreditChain = {
        usdc: async () => o.usdc,
        quote: async () => (o.quote === null ? null : { sendStroops: o.quote ?? 12_500_000n, path: [] }),
        sponsorAccount: async () => new Account(sponsorKp.publicKey(), String(100 + sent.length)),
        signSponsor: (x, p) => policySponsor(sponsorKp).signTransaction(x, p),
        async submit(x) {
          if (o.fail) throw o.fail;
          const tx = TransactionBuilder.fromXDR(x, P) as Transaction;
          sent.push(tx);
          return { hash: tx.hash().toString('hex') };
        },
        withSponsorLock: (fn) => fn(),
      };
      return { chain, sent };
    }
    const events: Record<string, unknown>[] = [];
    const run = async (chain: CreditChain, id: string) => {
      // Only this agent is due a look now: other tests' rows wait.
      await sql`update app.agents set credit_next_at = now() + interval '1 hour' where id <> ${id}`;
      await sql`update app.agents set credit_next_at = null where id = ${id}`;
      return createTestnetCredits({ sql, chain, keys, log: (e) => events.push(e) }).tick();
    };
    const row = async (id: string) =>
      ((await sql`select credit_tx, credit_at, credit_next_at > now() + interval '20 hours' as long_wait from app.agents where id = ${id}`) as { credit_tx: string | null; credit_at: Date | null; long_wait: boolean }[])[0]!;

    it('an agent below the floor gets exactly 1 USDC bought with the sponsor\'s XLM, then waits a day', async () => {
      const a = await agentWithKey();
      const f = fakeChain({ usdc: CREDIT_FLOOR_UNITS - 1n });
      expect(await run(f.chain, a.agentId)).toEqual({ credited: 1, full: 0, waiting: 0, failed: 0 });
      expect(f.sent).toHaveLength(1);
      const shape = creditShape(f.sent[0]!)!;
      expect(shape).toMatchObject({ agent: a.address, sponsor: sponsorKp.publicKey() });
      expect(shape.sendMaxStroops).toBe((12_500_000n * 102n) / 100n + 1n);
      expect(await row(a.agentId)).toMatchObject({ credit_tx: f.sent[0]!.hash().toString('hex'), long_wait: true });
    });

    it('leaves an agent that still holds enough, one without an account, and one whose reserves are due', async () => {
      const full = await agentWithKey();
      const f = fakeChain({ usdc: CREDIT_FLOOR_UNITS });
      expect(await run(f.chain, full.agentId)).toEqual({ credited: 0, full: 1, waiting: 0, failed: 0 });
      const none = await agentWithKey();
      const n = fakeChain({ usdc: null });
      expect(await run(n.chain, none.agentId)).toEqual({ credited: 0, full: 0, waiting: 1, failed: 0 });
      const due = await agentWithKey('due');
      const d = fakeChain({ usdc: 0n });
      expect(await run(d.chain, due.agentId)).toEqual({ credited: 0, full: 0, waiting: 1, failed: 0 });
      expect([...f.sent, ...n.sent, ...d.sent]).toHaveLength(0);
    });

    it('funds an agent born paused for want of funds (its first USDC), but never one its owner paused', async () => {
      const waits = await agentWithKey('due');
      await sql`update app.agents set status = 'paused', paused_for_funds = true where id = ${waits.agentId}`;
      const f = fakeChain({ usdc: 0n });
      expect(await run(f.chain, waits.agentId)).toEqual({ credited: 1, full: 0, waiting: 0, failed: 0 });
      expect(creditShape(f.sent[0]!)).toMatchObject({ agent: waits.address });
      const paused = await agentWithKey();
      await sql`update app.agents set status = 'paused' where id = ${paused.agentId}`;
      const p = fakeChain({ usdc: 0n });
      await run(p.chain, paused.agentId);
      expect(p.sent).toHaveLength(0);
    });

    it('a price over the cap, no route, or a failed submit waits and is logged; the kill switch stops it', async () => {
      const a = await agentWithKey();
      expect(await run(fakeChain({ usdc: 0n, quote: CREDIT_MAX_SEND_STROOPS }).chain, a.agentId)).toMatchObject({ failed: 1 });
      expect(await run(fakeChain({ usdc: 0n, quote: null }).chain, a.agentId)).toMatchObject({ failed: 1 });
      expect(await run(fakeChain({ usdc: 0n, fail: new Error('Horizon submit failed: 400 op_underfunded') }).chain, a.agentId)).toMatchObject({ failed: 1 });
      expect(events.filter((e) => e.event === 'agent_credit_failed').map((e) => e.code)).toEqual(expect.arrayContaining(['price_above_cap', 'no_path', 'sponsor_underfunded']));
      expect((await row(a.agentId)).credit_tx).toBeNull();
      const killed = fakeChain({ usdc: 0n });
      await sql`update app.agents set credit_next_at = null where id = ${a.agentId}`;
      expect(await createTestnetCredits({ sql, chain: killed.chain, keys, killed: () => true, log: () => {} }).tick()).toEqual({ credited: 0, full: 0, waiting: 0, failed: 0 });
    });
  });
});
