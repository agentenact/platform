import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Asset, Keypair, Operation, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { createAgents } from '../src/agents/index.js';
import { closeShape } from '../src/agents/close-tx.js';
import { createCloser, type CloseChain, type Holdings } from '../src/agents/close.js';
import { createReserves, FLOAT_LOW_STROOPS, HANDOVER_MIN_UNITS, type ReserveAccount, type ReserveChain } from '../src/agents/reserve.js';
import { buildHandoverTx, buildResponsorTx, buildTopupTx, FLOAT_STROOPS, MAX_REPAY_STROOPS, RESERVE_MAX_FEE_STROOPS, RESERVE_MAX_SEND_UNITS, RESERVE_STROOPS, reserveShape } from '../src/agents/reserve-tx.js';
import { createSponsorPolicy, policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault, HANDOVERS_PER_AGENT_DAY } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { bindPreimage } from './support/entries.js';
import { insertUser } from './support/fixtures.js';
import { minimalSpec } from './support/specs.js';

const P = TESTNET.passphrase;
const G = () => Keypair.random().publicKey();
const C = () => StrKey.encodeContract(randomBytes(32));
const USDC = new Asset(...(TESTNET.usdc.split(':') as [string, string]));
const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : ((e as { reason?: string } | null)?.reason ?? 'no error');
};

describe('reserve transaction shapes', () => {
  const sponsor = Keypair.random().publicKey();
  const agent = G();
  const b = (fee = '1000') => new TransactionBuilder(new Account(sponsor, '1'), { fee, networkPassphrase: P });
  const swap = (o: Partial<Parameters<typeof Operation.pathPaymentStrictReceive>[0]> = {}) =>
    Operation.pathPaymentStrictReceive({ source: agent, sendAsset: USDC, sendMax: '0.3', destination: agent, destAsset: Asset.native(), destAmount: '1.5', path: [], ...o });
  const handover = (s = swap()) =>
    b().addOperation(s).addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC })).setTimeout(60).build();

  it('a handover and a responsor are reserve shapes', () => {
    expect(reserveShape(buildHandoverTx(new Account(sponsor, '1'), agent, 3_000_000n, [], P))).toEqual({ kind: 'handover', sponsor, agent, sendMax: 3_000_000n, maxTime: expect.any(Number), floatStroops: 0n, repayStroops: 0n });
    expect(reserveShape(buildHandoverTx(new Account(sponsor, '1'), agent, 3_000_000n, [new Asset('yXLM', G())], P))).toMatchObject({ kind: 'handover' });
    expect(reserveShape(buildResponsorTx(new Account(sponsor, '1'), agent, P))).toMatchObject({ kind: 'responsor', sponsor, agent });
    expect(() => buildHandoverTx(new Account(sponsor, '1'), agent, RESERVE_MAX_SEND_UNITS + 1n, [], P)).toThrow();
  });

  it('refuses anything else', () => {
    // Paid to someone else, paid by the sponsor, another asset, another amount, over the cap.
    expect(reserveShape(handover(swap({ destination: G() })))).toBeNull();
    expect(reserveShape(handover(swap({ source: undefined })))).toBeNull();
    expect(reserveShape(handover(swap({ sendAsset: new Asset('USDC', G()) })))).toBeNull();
    expect(reserveShape(handover(swap({ destAmount: '2' })))).toBeNull();
    expect(reserveShape(handover(swap({ sendMax: '1.0000001' })))).toBeNull();
    // A revoke of another account, or an extra op.
    expect(reserveShape(b().addOperation(swap()).addOperation(Operation.revokeAccountSponsorship({ account: G() })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC })).setTimeout(60).build())).toBeNull();
    expect(reserveShape(b().addOperation(swap()).addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.payment({ destination: G(), asset: Asset.native(), amount: '1' })).setTimeout(60).build())).toBeNull();
    // The sponsor's own account, no time bound, over the fee cap.
    expect(reserveShape(buildResponsorTx(new Account(sponsor, '1'), sponsor, P))).toBeNull();
    expect(reserveShape(b().addOperation(swap()).addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC })).setTimeout(0).build())).toBeNull();
    expect(reserveShape(new TransactionBuilder(new Account(sponsor, '1'), { fee: String(RESERVE_MAX_FEE_STROOPS), networkPassphrase: P }).addOperation(swap()).addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC })).setTimeout(60).build())).toBeNull();
    // A responsor whose revokes the sponsor sources (that would revoke, not transfer).
    expect(reserveShape(b().addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent })).addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC, source: agent })).addOperation(Operation.endSponsoringFutureReserves({ source: agent })).setTimeout(60).build())).toBeNull();
  });

  it('the sponsor signs a reserve tx it sources, never one another account sources', () => {
    const kp = Keypair.random();
    const policy = createSponsorPolicy({ sponsorPublicKey: kp.publicKey() });
    expect(policy.check(buildHandoverTx(new Account(kp.publicKey(), '1'), agent, 3_000_000n, [], P).toXDR(), P).kind).toBe('reserve');
    expect(policy.check(buildResponsorTx(new Account(kp.publicKey(), '1'), agent, P).toXDR(), P).kind).toBe('reserve');
    expect(() => policy.check(buildHandoverTx(new Account(G(), '1'), agent, 3_000_000n, [], P).toXDR(), P)).toThrow();
  });
});

describe('self-paying reserve shapes (FEE_MODEL=agent)', () => {
  const kp = Keypair.random();
  const sponsor = kp.publicKey();
  const agent = G();
  const acct = () => new Account(sponsor, '1');
  const b = () => new TransactionBuilder(acct(), { fee: '1000', networkPassphrase: P });
  const swap = (destAmount: string, sendMax = '1') =>
    Operation.pathPaymentStrictReceive({ source: agent, sendAsset: USDC, sendMax, destination: agent, destAsset: Asset.native(), destAmount, path: [] });
  const revokes = (t: TransactionBuilder) =>
    t.addOperation(Operation.revokeAccountSponsorship({ account: agent })).addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC }));

  it('a handover buys reserves, a float and the repay, and pays exactly the repay to the sponsor that sources it', () => {
    const tx = buildHandoverTx(acct(), agent, 5_000_000n, [], P, { floatStroops: FLOAT_STROOPS, repayStroops: 3_000_000n });
    expect(reserveShape(tx)).toMatchObject({ kind: 'handover', agent, floatStroops: FLOAT_STROOPS, repayStroops: 3_000_000n });
    expect(createSponsorPolicy({ sponsorPublicKey: sponsor }).check(tx.toXDR(), P).kind).toBe('reserve');
    // The swap must buy exactly reserve + float + repay.
    expect(reserveShape(revokes(b().addOperation(swap('2.9'))).addOperation(Operation.payment({ source: agent, destination: sponsor, asset: Asset.native(), amount: '0.3' })).setTimeout(60).build())).toBeNull();
    // The repay goes to nobody but the sponsor, from the agent, in XLM, within the cap.
    const pay = (o: Partial<Parameters<typeof Operation.payment>[0]>) =>
      reserveShape(revokes(b().addOperation(swap('2.8'))).addOperation(Operation.payment({ source: agent, destination: sponsor, asset: Asset.native(), amount: '0.3', ...o })).setTimeout(60).build());
    expect(pay({})).toMatchObject({ kind: 'handover', repayStroops: 3_000_000n });
    expect(pay({ destination: G() })).toBeNull();
    expect(pay({ source: undefined })).toBeNull();
    expect(pay({ asset: USDC })).toBeNull();
    expect(() => buildHandoverTx(acct(), agent, 5_000_000n, [], P, { floatStroops: FLOAT_STROOPS, repayStroops: MAX_REPAY_STROOPS + 1n })).toThrow();
    // The price cap scales with what is bought: 1 USDC per 1.5 XLM.
    expect(() => buildHandoverTx(acct(), agent, 16_666_667n, [], P, { floatStroops: FLOAT_STROOPS })).toThrow();
  });

  it('a topup buys exactly the float into the agent\'s own account, nothing more', () => {
    expect(reserveShape(buildTopupTx(acct(), agent, 2_000_000n, [], P))).toMatchObject({ kind: 'topup', agent, sendMax: 2_000_000n });
    expect(reserveShape(b().addOperation(swap('2')).setTimeout(60).build())).toBeNull();
    expect(reserveShape(b().addOperation(swap('1', '0.7')).setTimeout(60).build())).toBeNull();
    expect(() => buildTopupTx(acct(), agent, 7_000_000n, [], P)).toThrow();
  });
});

describe('extra agents and their reserves', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  const sponsorKp = Keypair.random();
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
  });
  afterAll(() => drop());

  const state = async (id: string) =>
    ((await sql`select reserve_state, reserve_tx, reserve_usdc_units, reserve_attempts, reserve_error from app.agents where id = ${id}`) as {
      reserve_state: string;
      reserve_tx: string | null;
      reserve_usdc_units: string | null;
      reserve_attempts: number;
      reserve_error: string | null;
    }[])[0]!;
  /** An active agent with a vault key, `reserve` as given. */
  async function agentWithKey(reserve: 'free' | 'due' | 'self_paid', owner: string | null = C(), userId?: string) {
    const uid = userId ?? (await insertUser(sql, { ownerAddress: owner }));
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id, reserve_state) values (${uid}, 'Scout', 'provisioning', '77', ${reserve}) returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    // Bound to its user's owner, as provisioning does: the vault pins that owner for the close.
    const [u] = (await sql`select owner_address from app.users where id = ${uid}`) as { owner_address: string | null }[];
    if (u?.owner_address) await keys.agentSigner(id, publicKey).signAuthEntry(bindPreimage(u.owner_address, publicKey));
    await sql`update app.agents set status = 'active', stellar_address = ${publicKey} where id = ${id}`;
    return { userId: uid, agentId: id, address: publicKey, owner };
  }

  describe('creating', () => {
    it('the first agent is the platform\'s, the next waits for its funding, a third waits for that one', async () => {
      const userId = await insertUser(sql, { ownerAddress: C() });
      const agents = createAgents(sql, { limits: { live: 5, perDay: 5 }, feeModel: 'sponsor' });
      const one = await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
      const two = await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID());
      expect((await state(one.id)).reserve_state).toBe('free');
      expect((await state(two.id)).reserve_state).toBe('due');
      await expect(agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'reserve_due' });
      // Once Two holds its own reserves, a third may come (and waits in turn).
      await sql`update app.agents set reserve_state = 'self_paid' where id = ${two.id}`;
      const three = await agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID());
      expect((await state(three.id)).reserve_state).toBe('due');
    });

    it('a due agent whose birth failed does not block the next one', async () => {
      const userId = await insertUser(sql, { ownerAddress: C() });
      const agents = createAgents(sql, { limits: { live: 5, perDay: 5 }, feeModel: 'sponsor' });
      await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
      const two = await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID());
      await sql`update app.agents set provision_state = '{"step": "failed", "attempts": []}' where id = ${two.id}`;
      expect((await agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID())).resumed).toBe(false);
    });

    it('deleting the free agent hands its place to the oldest waiting one; deleting a waiting one changes nothing else', async () => {
      const userId = await insertUser(sql, { ownerAddress: C() });
      const agents = createAgents(sql, { limits: { live: 5, perDay: 5 }, feeModel: 'sponsor' });
      const one = await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
      const two = await agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID());
      await agents.remove(userId, one.id);
      expect((await state(two.id)).reserve_state).toBe('free');
      const three = await agents.create(userId, 'Three', minimalSpec(), undefined, crypto.randomUUID());
      expect((await state(three.id)).reserve_state).toBe('due');
      await agents.remove(userId, three.id);
      expect((await state(two.id)).reserve_state).toBe('free');
    });
  });

  describe('the vault signs the agent\'s part of a reserve tx', () => {
    const handover = (address: string, sponsor = sponsorKp.publicKey()) => buildHandoverTx(new Account(sponsor, '1'), address, 3_000_000n, [], P);
    const responsor = (address: string) => buildResponsorTx(new Account(sponsorKp.publicKey(), '1'), address, P);

    it('a handover for a live, due agent, within its day count', async () => {
      const a = await agentWithKey('due');
      const tx = handover(a.address);
      const sig = await keys.signReserve(a.agentId, tx.toXDR(), P);
      expect(Keypair.fromPublicKey(a.address).verify(tx.hash(), Buffer.from(sig, 'base64'))).toBe(true);
      for (let i = 1; i < HANDOVERS_PER_AGENT_DAY; i++) await keys.signReserve(a.agentId, handover(a.address).toXDR(), P);
      expect(await reasonOf(keys.signReserve(a.agentId, handover(a.address).toXDR(), P))).toBe('over_day_cap');
    });

    it('refuses a handover for the free agent, another wallet, another sponsor, or a deleted agent', async () => {
      const free = await agentWithKey('free');
      expect(await reasonOf(keys.signReserve(free.agentId, handover(free.address).toXDR(), P))).toBe('bad_payload');
      const a = await agentWithKey('due');
      expect(await reasonOf(keys.signReserve(a.agentId, handover(G()).toXDR(), P))).toBe('wrong_wallet');
      expect(await reasonOf(keys.signReserve(a.agentId, handover(a.address, G()).toXDR(), P))).toBe('bad_payload');
      expect(await reasonOf(keys.signReserve(a.agentId, handover(a.address).toXDR(), 'Public Global Stellar Network ; September 2015'))).toBe('wrong_network');
      expect(await reasonOf(keys.signReserve(a.agentId, responsor(a.address).toXDR(), P))).toBe('not_deleted');
      await createAgents(sql, { feeModel: 'sponsor' }).remove(a.userId, a.agentId);
      expect(await reasonOf(keys.signReserve(a.agentId, handover(a.address).toXDR(), P))).toBe('not_active');
      expect(await reasonOf(keys.signReserve(a.agentId, responsor(a.address).toXDR(), P))).toBe('no error');
    });
  });

  describe('the handover worker', () => {
    function fakeChain(o: { account: ReserveAccount | null | (() => ReserveAccount | null); quote?: bigint | null; fail?: Error }) {
      const sent: Transaction[] = [];
      const chain: ReserveChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        account: async () => (typeof o.account === 'function' ? o.account() : o.account),
        quote: async () => (o.quote === null ? null : { sendUnits: o.quote ?? 2_500_000n, path: [] }),
        feeCharged: async () => 1_000_000n,
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
    const run = async (chain: ReserveChain, id: string) => {
      // Only this agent is due now: other tests' rows wait.
      await sql`update app.agents set reserve_next_at = now() + interval '1 hour' where reserve_state = 'due' and id <> ${id}`;
      await sql`update app.agents set reserve_next_at = null where id = ${id}`;
      return createReserves({ sql, chain, keys, log: (e) => events.push(e) }).tick();
    };

    it('waits while the agent holds too little USDC, then buys its reserves with its own', async () => {
      const a = await agentWithKey('due');
      const low = fakeChain({ account: { sponsored: true, usdc: HANDOVER_MIN_UNITS - 1n, xlm: 0n } });
      expect(await run(low.chain, a.agentId)).toEqual({ handed: 0, waiting: 1, failed: 0, topped: 0 });
      expect(low.sent).toHaveLength(0);
      expect(await state(a.agentId)).toMatchObject({ reserve_state: 'due', reserve_attempts: 0 });

      const funded = fakeChain({ account: { sponsored: true, usdc: 10_000_000n, xlm: 0n } });
      expect(await run(funded.chain, a.agentId)).toEqual({ handed: 1, waiting: 0, failed: 0, topped: 0 });
      const tx = funded.sent[0]!;
      // 2 % over the 0.25 quote, plus a unit.
      expect(reserveShape(tx)).toMatchObject({ kind: 'handover', agent: a.address, sendMax: 2_550_001n });
      expect(tx.signatures).toHaveLength(2);
      expect(await state(a.agentId)).toMatchObject({ reserve_state: 'self_paid', reserve_tx: tx.hash().toString('hex'), reserve_usdc_units: '2500000' });
    });

    it('records an account nobody sponsors any more without sending anything', async () => {
      const a = await agentWithKey('due');
      const { chain, sent } = fakeChain({ account: { sponsored: false, usdc: 0n, xlm: 0n } });
      expect((await run(chain, a.agentId)).handed).toBe(1);
      expect(sent).toHaveLength(0);
      expect(await state(a.agentId)).toMatchObject({ reserve_state: 'self_paid', reserve_tx: null });
    });

    it('a price over the cap or a failed submit is retried later; the agent stays due', async () => {
      const a = await agentWithKey('due');
      expect((await run(fakeChain({ account: { sponsored: true, usdc: 50_000_000n, xlm: 0n }, quote: RESERVE_MAX_SEND_UNITS }).chain, a.agentId)).failed).toBe(1);
      expect(await state(a.agentId)).toMatchObject({ reserve_state: 'due', reserve_attempts: 1, reserve_error: 'price_above_cap' });
      expect((await run(fakeChain({ account: { sponsored: true, usdc: 50_000_000n, xlm: 0n }, fail: new Error('chain: Horizon submit failed: 400 Transaction Failed {"operations":["op_too_few_offers"]}') }).chain, a.agentId)).failed).toBe(1);
      expect(await state(a.agentId)).toMatchObject({ reserve_state: 'due', reserve_attempts: 2, reserve_error: 'swap_failed' });
    });

    it('leaves free, self-paid, paused-while-provisioning and deleted agents alone, and stops on the kill switch', async () => {
      const free = await agentWithKey('free');
      const { chain, sent } = fakeChain({ account: { sponsored: true, usdc: 50_000_000n, xlm: 0n } });
      await run(chain, free.agentId);
      const gone = await agentWithKey('due');
      await createAgents(sql, { feeModel: 'sponsor' }).remove(gone.userId, gone.agentId);
      await run(chain, gone.agentId);
      expect(sent).toHaveLength(0);
      const due = await agentWithKey('due');
      await sql`update app.agents set reserve_next_at = null where id = ${due.agentId}`;
      expect(await createReserves({ sql, chain, keys, killed: () => true, log: () => undefined }).tick()).toEqual({ handed: 0, waiting: 0, failed: 0, topped: 0 });
    });
  });

  describe('deleting a self-paid agent', () => {
    function closeChain(script: Holdings[]) {
      const sent: Transaction[] = [];
      const reads = [...script];
      const chain: CloseChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        getAccount: async (id) => new Account(id, String(10 + sent.length)),
        holdings: async () => (reads.length > 1 ? reads.shift()! : reads[0]!),
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

    it('a C owner: the sponsor takes the reserves back, the freed XLM is swept to the owner, the merge goes to the sponsor', async () => {
      const a = await agentWithKey('self_paid');
      await createAgents(sql, { feeModel: 'sponsor' }).remove(a.userId, a.agentId);
      const { chain, sent } = closeChain([
        { usdc: 0n, xlm: 0n, blockers: 0, sponsored: false },
        { usdc: 0n, xlm: 15_000_000n, blockers: 0, sponsored: true },
        { usdc: 0n, xlm: 0n, blockers: 0, sponsored: true },
      ]);
      const responsors: string[] = [];
      const responsor = async (agentId: string, address: string) => {
        const tx = buildResponsorTx(new Account(sponsorKp.publicKey(), '1'), address, P);
        await keys.signReserve(agentId, tx.toXDR(), P); // the vault agrees: the agent is deleted
        responsors.push(address);
        return 'f'.repeat(64);
      };
      await createCloser({ sql, chain, keys, responsor, log: () => undefined }).close(a.agentId);
      expect(responsors).toEqual([a.address]);
      expect(sent.map((t) => closeShape(t))).toMatchObject([
        { kind: 'sweep', asset: 'xlm', to: a.owner, amount: 15_000_000n },
        { kind: 'merge', destination: sponsorKp.publicKey() },
      ]);
      const r = ((await sql`select close_state, close_txs from app.agents where id = ${a.agentId}`) as { close_state: string; close_txs: string[] }[])[0]!;
      expect(r.close_state).toBe('closed');
      expect(r.close_txs[0]).toBe('f'.repeat(64));
    });

    it('a G owner: the merge itself returns the reserves, no responsor', async () => {
      const owner = G();
      const a = await agentWithKey('self_paid', owner);
      await createAgents(sql, { feeModel: 'sponsor' }).remove(a.userId, a.agentId);
      const { chain, sent } = closeChain([{ usdc: 0n, xlm: 0n, blockers: 0, sponsored: false }]);
      let called = 0;
      await createCloser({ sql, chain, keys, responsor: async () => (called++, 'x'), log: () => undefined }).close(a.agentId);
      expect(called).toBe(0);
      expect(sent.map((t) => closeShape(t))).toMatchObject([{ kind: 'merge', destination: owner }]);
    });
  });
});

describe('every agent pays its own way (FEE_MODEL=agent)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  const sponsorKp = Keypair.random();
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: policySponsor(sponsorKp) }));
  });
  afterAll(() => drop());

  const row = async (id: string) =>
    ((await sql`select status, reserve_state, pays_own_fees, reserve_repay_stroops::text as repay, reserve_next_at from app.agents where id = ${id}`) as {
      status: string;
      reserve_state: string;
      pays_own_fees: boolean;
      repay: string | null;
      reserve_next_at: Date | null;
    }[])[0]!;
  async function agentWithKey(o: { reserve: 'due' | 'self_paid'; status?: string; paysOwn?: boolean; txs?: Record<string, string>; waits?: boolean }) {
    const uid = await insertUser(sql, { ownerAddress: C() });
    const state = { step: 'active', attempts: [{ n: 1, publicKey: 'x', startedAt: new Date().toISOString(), txs: o.txs ?? {} }] };
    const status = o.status ?? 'paused';
    const id = ((await sql`insert into app.agents (user_id, name, status, agent_id, reserve_state, pays_own_fees, provision_state, paused_for_funds)
                          values (${uid}, 'Scout', ${status}, '77', ${o.reserve}, ${o.paysOwn ?? false}, ${state}, ${o.waits ?? status === 'paused'}) returning id`) as { id: string }[])[0]!.id;
    const { publicKey } = await keys.generate(id);
    await sql`update app.agents set stellar_address = ${publicKey} where id = ${id}`;
    return { userId: uid, agentId: id, address: publicKey };
  }

  it('the first agent is due too, one unfunded agent at a time, and none can be resumed before it is funded', async () => {
    const userId = await insertUser(sql, { ownerAddress: C() });
    const agents = createAgents(sql, { limits: { live: 5, perDay: 5 } });
    const one = await agents.create(userId, 'One', minimalSpec(), undefined, crypto.randomUUID());
    expect((await row(one.id)).reserve_state).toBe('due');
    await expect(agents.create(userId, 'Two', minimalSpec(), undefined, crypto.randomUUID())).rejects.toMatchObject({ status: 409, code: 'reserve_due' });
    await sql`update app.agents set status = 'paused', paused_for_funds = true where id = ${one.id}`;
    await expect(agents.resume(userId, one.id)).rejects.toMatchObject({ status: 409, code: 'awaiting_funds' });
    await sql`update app.agents set reserve_state = 'self_paid', paused_for_funds = false where id = ${one.id}`;
    await agents.resume(userId, one.id);
    expect((await row(one.id)).status).toBe('active');
  });

  it('the vault signs a repay of exactly what the row says, and a topup only for a self-paying agent', async () => {
    const a = await agentWithKey({ reserve: 'due' });
    const handover = (repay: bigint) => buildHandoverTx(new Account(sponsorKp.publicKey(), '1'), a.address, 5_000_000n, [], P, { floatStroops: FLOAT_STROOPS, repayStroops: repay });
    expect(await reasonOf(keys.signReserve(a.agentId, handover(3_000_000n).toXDR(), P))).toBe('bad_payload');
    await sql`update app.agents set reserve_repay_stroops = 2000000 where id = ${a.agentId}`;
    expect(await reasonOf(keys.signReserve(a.agentId, handover(3_000_000n).toXDR(), P))).toBe('bad_payload');
    expect(await reasonOf(keys.signReserve(a.agentId, handover(2_000_000n).toXDR(), P))).toBe('no error');
    const topup = (address: string) => buildTopupTx(new Account(sponsorKp.publicKey(), '1'), address, 2_000_000n, [], P).toXDR();
    expect(await reasonOf(keys.signReserve(a.agentId, topup(a.address), P))).toBe('bad_payload');
    const s = await agentWithKey({ reserve: 'self_paid', status: 'active', paysOwn: true });
    expect(await reasonOf(keys.signReserve(s.agentId, topup(s.address), P))).toBe('no error');
    const legacy = await agentWithKey({ reserve: 'self_paid', status: 'active', paysOwn: false });
    expect(await reasonOf(keys.signReserve(legacy.agentId, topup(legacy.address), P))).toBe('bad_payload');
  });

  describe('the worker', () => {
    function fakeChain(o: { account: ReserveAccount; fees?: Record<string, bigint> }) {
      const sent: Transaction[] = [];
      const quoted: bigint[] = [];
      const chain: ReserveChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        account: async () => o.account,
        // A quarter USDC per 1.5 XLM.
        quote: async (dest) => (quoted.push(dest), { sendUnits: (dest * 2_500_000n) / RESERVE_STROOPS, path: [] }),
        feeCharged: async (h) => o.fees?.[h] ?? 0n,
        sponsorAccount: async () => new Account(sponsorKp.publicKey(), String(100 + sent.length)),
        signSponsor: (x, p) => policySponsor(sponsorKp).signTransaction(x, p),
        async submit(x) {
          const tx = TransactionBuilder.fromXDR(x, P) as Transaction;
          sent.push(tx);
          return { hash: tx.hash().toString('hex') };
        },
        withSponsorLock: (fn) => fn(),
      };
      return { chain, sent, quoted };
    }
    const run = async (chain: ReserveChain, id: string) => {
      await sql`update app.agents set reserve_next_at = now() + interval '1 hour' where id <> ${id} and reserve_next_at is null or reserve_next_at < now()`;
      await sql`update app.agents set reserve_next_at = case when reserve_state = 'due' then null else now() end where id = ${id}`;
      return createReserves({ sql, chain, keys, feeModel: 'agent', log: () => undefined }).tick();
    };
    const h = (c: string) => c.repeat(64);

    it('at its first funding an agent buys reserves and a float, pays back its birth fees, and is resumed', async () => {
      const a = await agentWithKey({ reserve: 'due', txs: { account: h('a'), register: h('b'), bind: h('c') } });
      const { chain, sent, quoted } = fakeChain({ account: { sponsored: true, usdc: 20_000_000n, xlm: 0n }, fees: { [h('a')]: 100n, [h('b')]: 2_650_000n, [h('c')]: 61_156n } });
      expect((await run(chain, a.agentId)).handed).toBe(1);
      const repay = 100n + 2_650_000n + 61_156n;
      expect(quoted).toEqual([RESERVE_STROOPS + FLOAT_STROOPS + repay]);
      expect(reserveShape(sent[0]!)).toMatchObject({ kind: 'handover', floatStroops: FLOAT_STROOPS, repayStroops: repay });
      expect(await row(a.agentId)).toMatchObject({ status: 'active', reserve_state: 'self_paid', pays_own_fees: true, repay: String(repay) });
    });

    it('an agent its owner paused stays paused when it is funded', async () => {
      const a = await agentWithKey({ reserve: 'due', waits: false });
      const { chain } = fakeChain({ account: { sponsored: true, usdc: 20_000_000n, xlm: 0n } });
      expect((await run(chain, a.agentId)).handed).toBe(1);
      expect(await row(a.agentId)).toMatchObject({ status: 'paused', reserve_state: 'self_paid' });
    });

    it('a flagged self-paying agent low on XLM buys another float; one with enough is let be', async () => {
      const a = await agentWithKey({ reserve: 'self_paid', status: 'active', paysOwn: true });
      const low = fakeChain({ account: { sponsored: false, usdc: 20_000_000n, xlm: FLOAT_LOW_STROOPS - 1n } });
      expect((await run(low.chain, a.agentId)).topped).toBe(1);
      expect(reserveShape(low.sent[0]!)).toMatchObject({ kind: 'topup', agent: a.address });
      expect((await row(a.agentId)).reserve_next_at).toBeNull();
      const fine = fakeChain({ account: { sponsored: false, usdc: 20_000_000n, xlm: FLOAT_LOW_STROOPS } });
      expect((await run(fine.chain, a.agentId)).topped).toBe(1);
      expect(fine.sent).toHaveLength(0);
    });
  });
});
