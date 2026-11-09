import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Account, Asset, FeeBumpTransaction, Keypair, Memo, Operation, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { createActivity } from '../src/activity/index.js';
import { createSponsorPolicy, policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault, SEALS_PER_AGENT_DAY } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { canonicalJson, decisionBytes, DECISION_VERSION, parseDecision, parseSeal, sealBytes, SEAL_VERSION, type DecisionDocument, type SealDocument } from '../src/seals/format.js';
import { createSeals, MAX_ATTEMPTS, retryDelayS, type SealChain } from '../src/seals/index.js';
import { buildSealTx, feeBumpSeal, sealShape, SEAL_MAX_FEE_STROOPS } from '../src/seals/tx.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const P = TESTNET.passphrase;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const G = () => Keypair.random().publicKey();
const doc = (over: Partial<SealDocument> = {}): SealDocument => ({
  v: SEAL_VERSION,
  network: 'stellar:testnet',
  agent: G(),
  agentId: '31',
  at: '2026-10-29T12:00:00.000Z',
  held: false,
  reading: { symbol: 'XLM', changePct: -0.4, price: 0.1913 },
  salt: 'ab'.repeat(16),
  ...over,
});

/** The document carries hashes of the mission's words, never the words. */
const document_has_no_text = (doc: string, text: string) => !doc.includes(text) && !doc.includes('XLM fell');

describe('seal document', () => {
  it('is canonical JSON: sorted keys at every depth, no whitespace, and parses back only when exact', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[2,"x"]},"b":1}');
    const d = doc();
    const bytes = sealBytes(d);
    expect(bytes.startsWith('{"agent":')).toBe(true);
    expect(bytes).not.toContain(' ');
    expect(parseSeal(bytes)).toEqual(d);
    expect(parseSeal(JSON.stringify(d, null, 1))).toBeNull(); // the same content, not the same bytes
    expect(parseSeal(bytes.replace('"held":false', '"held":true'))).not.toBeNull(); // a different, still valid document
  });

  it('refuses what cannot be checked exactly', () => {
    expect(() => sealBytes(doc({ agent: 'GNOPE' }))).toThrow();
    expect(() => sealBytes(doc({ salt: 'short' }))).toThrow();
    expect(() => sealBytes(doc({ at: '2026-10-29T12:00:00Z' }))).toThrow(); // not the canonical ISO form
    expect(() => sealBytes(doc({ reading: { x: Number.NaN } }))).toThrow();
    expect(() => sealBytes(doc({ reading: { x: { y: 1 } as never } }))).toThrow();
    expect(() => sealBytes(doc({ agentId: 'abc' }))).toThrow();
  });
});

describe('seal transaction shape', () => {
  const agent = Keypair.random();
  const sponsor = Keypair.random();
  const digest = sha('x');
  const inner = () => buildSealTx(new Account(agent.publicKey(), '41'), digest, P);

  it('is a no-op from the agent carrying the digest, with a bounded validity', () => {
    const tx = inner();
    expect(tx.source).toBe(agent.publicKey());
    expect(tx.sequence).toBe('42');
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: 'bumpSequence', bumpTo: '0' });
    expect(sealShape(tx)).toMatchObject({ agent: agent.publicKey(), digest });
  });

  it('refuses any other shape', () => {
    const b = (f: (x: TransactionBuilder) => TransactionBuilder, fee = '100') =>
      f(new TransactionBuilder(new Account(agent.publicKey(), '1'), { fee, networkPassphrase: P }));
    expect(sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '9' })).addMemo(Memo.hash(digest)).setTimeout(60)).build())).toBeNull();
    expect(sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '0', source: G() })).addMemo(Memo.hash(digest)).setTimeout(60)).build())).toBeNull();
    expect(sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '0' })).addMemo(Memo.text('hi')).setTimeout(60)).build())).toBeNull();
    expect(sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '0' })).addMemo(Memo.hash(digest)).setTimeout(0)).build())).toBeNull();
    expect(
      sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '0' })).addOperation(Operation.bumpSequence({ bumpTo: '0' })).addMemo(Memo.hash(digest)).setTimeout(60)).build()),
    ).toBeNull();
    expect(sealShape(b((x) => x.addOperation(Operation.bumpSequence({ bumpTo: '0' })).addMemo(Memo.hash(digest)).setTimeout(60), '5000').build())).toBeNull();
    expect(sealShape(b((x) => x.addOperation(Operation.payment({ destination: G(), asset: Asset.native(), amount: '1' })).addMemo(Memo.hash(digest)).setTimeout(60)).build())).toBeNull();
  });

  it('the sponsor pays a seal fee-bump and nothing that only looks like one', () => {
    const policy = createSponsorPolicy({ sponsorPublicKey: sponsor.publicKey() });
    const fb = feeBumpSeal(inner(), sponsor.publicKey(), P);
    expect(BigInt(fb.fee)).toBe(200n);
    expect(policy.check(fb.toXDR(), P).kind).toBe('seal');
    // Someone else as the fee source, a fee over the cap, or a seal "from" the sponsor itself.
    expect(() => policy.check(feeBumpSeal(inner(), G(), P).toXDR(), P)).toThrow('refuses');
    const rich = TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), String(SEAL_MAX_FEE_STROOPS), inner(), P);
    expect(() => policy.check(rich.toXDR(), P)).toThrow('above cap');
    const own = feeBumpSeal(buildSealTx(new Account(sponsor.publicKey(), '1'), digest, P), sponsor.publicKey(), P);
    expect(() => policy.check(own.toXDR(), P)).toThrow('refuses');
    // A fee-bump around anything else.
    const other = TransactionBuilder.buildFeeBumpTransaction(
      sponsor.publicKey(),
      '100',
      new TransactionBuilder(new Account(agent.publicKey(), '1'), { fee: '100', networkPassphrase: P }).addOperation(Operation.bumpSequence({ bumpTo: '5' })).setTimeout(60).build(),
      P,
    );
    expect(() => policy.check(other.toXDR(), P)).toThrow('refuses');
  });
});

describe('check seals (vault, worker, activity)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let keys: AgentKeys;
  const sponsorKp = Keypair.random();
  let now = new Date();
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const raw = createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });
    keys = localAgentKeys(createVault({ sql, keys: raw, sponsor: policySponsor(sponsorKp), now: () => now }));
  });
  afterAll(() => drop());
  beforeEach(() => {
    now = new Date();
  });

  const agent = async (status = 'active') => {
    const userId = await insertUser(sql, { ownerAddress: StrKey.encodeContract(randomBytes(32)) });
    const id = await insertAgent(sql, userId, { status });
    const { publicKey } = await keys.generate(id);
    await sql`update app.agents set stellar_address = ${publicKey}, agent_id = '31' where id = ${id}`;
    return { id, userId, address: publicKey };
  };
  const reasonOf = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x: unknown) => x);
    return isVaultRefusal(e) ? e.reason : 'no error';
  };

  describe('vault', () => {
    it('signs the agent\'s own seal over its tx hash, and counts it', async () => {
      const a = await agent();
      const tx = buildSealTx(new Account(a.address, '7'), sha('d'), P);
      const sig = await keys.signSeal(a.id, tx.toXDR(), P);
      expect(Keypair.fromPublicKey(a.address).verify(tx.hash(), Buffer.from(sig, 'base64'))).toBe(true);
      const [r] = (await sql`select kind, digest from keyvault.signatures where agent_id = ${a.id}`) as { kind: string; digest: string }[];
      expect(r).toEqual({ kind: 'seal', digest: tx.hash().toString('hex') });
    });

    it('refuses another account, another shape, a long validity, a revoked agent, mainnet, and past the day count', async () => {
      const a = await agent();
      const sign = (t: Transaction, p = P) => reasonOf(keys.signSeal(a.id, t.toXDR(), p));
      expect(await sign(buildSealTx(new Account(G(), '1'), sha('x'), P))).toBe('wrong_wallet');
      const pay = new TransactionBuilder(new Account(a.address, '1'), { fee: '100', networkPassphrase: P }).addOperation(Operation.bumpSequence({ bumpTo: '3' })).addMemo(Memo.hash(sha('x'))).setTimeout(60).build();
      expect(await sign(pay)).toBe('bad_payload');
      const late = new TransactionBuilder(new Account(a.address, '1'), { fee: '100', networkPassphrase: P }).addOperation(Operation.bumpSequence({ bumpTo: '0' })).addMemo(Memo.hash(sha('x'))).setTimeout(3600).build();
      expect(await sign(late)).toBe('bad_payload');
      expect(await reasonOf(keys.signSeal(a.id, buildSealTx(new Account(a.address, '1'), sha('x'), 'Public Global Stellar Network ; September 2015').toXDR(), 'Public Global Stellar Network ; September 2015'))).toBe('wrong_network');
      const fb = feeBumpSeal(buildSealTx(new Account(a.address, '1'), sha('x'), P), sponsorKp.publicKey(), P);
      expect(await reasonOf(keys.signSeal(a.id, fb.toXDR(), P))).toBe('bad_payload');
      const r = await agent('revoked');
      expect(await reasonOf(keys.signSeal(r.id, buildSealTx(new Account(r.address, '1'), sha('x'), P).toXDR(), P))).toBe('not_active');
      // The day count: filled to the cap directly, then one more is refused.
      await sql`insert into keyvault.signatures (agent_id, kind, digest) select ${a.id}, 'seal', md5(g::text) || md5(g::text) from generate_series(1, ${SEALS_PER_AGENT_DAY}) g`;
      expect(await sign(buildSealTx(new Account(a.address, '1'), sha('y'), P))).toBe('over_day_cap');
    });

    it('signs for a paused agent (its last checks may still be queued)', async () => {
      const a = await agent('paused');
      expect(typeof (await keys.signSeal(a.id, buildSealTx(new Account(a.address, '1'), sha('p'), P).toXDR(), P))).toBe('string');
    });
  });

  describe('worker', () => {
    type Sent = { xdr: string; fb: FeeBumpTransaction };
    const fakeChain = (o: { fail?: (n: number) => Error | null; seqs?: Map<string, bigint> } = {}) => {
      const sent: Sent[] = [];
      const seqs = o.seqs ?? new Map<string, bigint>();
      let n = 0;
      const chain: SealChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        // Realistic: a fresh account's sequence is ledger << 32, far above zero.
        getAccount: async (id) => new Account(id, String(seqs.get(id) ?? 5_000n << 32n)),
        // The vault path for the sponsor, as production: policy, day fee cap, signature row.
        signSponsor: (x, p) => keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(x, p),
        submit: async (x) => {
          const err = o.fail?.(n++) ?? null;
          if (err) throw err;
          const fb = TransactionBuilder.fromXDR(x, P) as FeeBumpTransaction;
          const inner = fb.innerTransaction;
          seqs.set(inner.source, BigInt(inner.sequence));
          sent.push({ xdr: x, fb });
          return { hash: fb.hash().toString('hex') };
        },
      };
      return { chain, sent };
    };
    const seals = (chain: SealChain, killed = false) =>
      createSeals({ sql, chain, signSeal: (a, x, p) => keys.signSeal(a, x, p), killed: () => killed, log: () => undefined, now: () => now });
    const rows = async (agentId: string) =>
      (await sql`select status, attempts, tx_hash, error, digest, document from app.check_seals where agent_id = ${agentId} order by check_at, id`) as {
        status: string;
        attempts: number;
        tx_hash: string | null;
        error: string | null;
        digest: string;
        document: string;
      }[];

    it('queues each check with its salted document and lands it as the agent\'s own fee-bumped no-op, in order', async () => {
      const a = await agent();
      const { chain, sent } = fakeChain();
      const s = seals(chain);
      await s.enqueue(a.id, { held: false, reading: { symbol: 'XLM', changePct: -0.4 }, at: new Date(Date.now() - 2000) });
      await s.enqueue(a.id, { held: true, reading: null, at: new Date(Date.now() - 1000) });
      const queued = await rows(a.id);
      expect(queued.map((r) => r.status)).toEqual(['pending', 'pending']);
      for (const r of queued) {
        expect(sha(r.document)).toBe(r.digest);
        expect(parseSeal(r.document)).toMatchObject({ agent: a.address, agentId: '31' });
      }
      expect(parseSeal(queued[0]!.document)!.salt).not.toBe(parseSeal(queued[1]!.document)!.salt);

      expect(await s.tick()).toEqual({ sent: 2, retried: 0, failed: 0 });
      const done = await rows(a.id);
      expect(done.map((r) => r.status)).toEqual(['sent', 'sent']);
      expect(sent).toHaveLength(2);
      for (const [i, x] of sent.entries()) {
        const inner = x.fb.innerTransaction;
        expect(x.fb.feeSource).toBe(sponsorKp.publicKey());
        expect(inner.source).toBe(a.address);
        expect((inner.memo.value as Buffer).toString('hex')).toBe(done[i]!.digest);
        expect(Keypair.fromPublicKey(a.address).verify(inner.hash(), inner.signatures[0]!.signature())).toBe(true);
        expect(sponsorKp.verify(x.fb.hash(), x.fb.signatures[0]!.signature())).toBe(true);
        expect(done[i]!.tx_hash).toBe(x.fb.hash().toString('hex'));
      }
      // One account read, then the sequence moves on locally: consecutive.
      expect(BigInt(sent[1]!.fb.innerTransaction.sequence) - BigInt(sent[0]!.fb.innerTransaction.sequence)).toBe(1n);
      const kinds = (await sql`select kind from keyvault.sponsor_signatures order by id desc limit 2`) as { kind: string }[];
      expect(kinds.map((k) => k.kind)).toEqual(['seal', 'seal']);
    });

    it('stores each seal\'s signature as Horizon shows it, finds the seal by it, and back-fills older seals one per tick', async () => {
      const a = await agent();
      const { chain, sent } = fakeChain();
      const s = seals(chain);
      await s.enqueue(a.id, { held: false, reading: null, at: new Date(Date.now() - 1000) });
      await s.tick();
      const sig = sent[0]!.fb.innerTransaction.signatures[0]!.signature().toString('base64');
      const [row] = (await sql`select signature, tx_hash from app.check_seals where agent_id = ${a.id}`) as { signature: string; tx_hash: string }[];
      expect(row!.signature).toBe(sig);
      expect(await s.bySignature(sig)).toBe(row!.tx_hash);
      expect(await s.bySignature('A'.repeat(86) + '==')).toBeNull();
      expect(await s.bySignature("x' or 1=1")).toBeNull();

      // A seal sent before signatures were kept: the worker reads it from Horizon, newest first; gone from Horizon is ''.
      await sql`update app.check_seals set signature = null where agent_id = ${a.id}`;
      const asked: string[] = [];
      const old = seals({ ...chain, txSignature: async (h) => (asked.push(h), h === row!.tx_hash ? sig : null) });
      await old.tick();
      expect(asked).toEqual([row!.tx_hash]);
      expect(await old.bySignature(sig)).toBe(row!.tx_hash);
      await sql`update app.check_seals set signature = null where agent_id = ${a.id}`;
      await seals({ ...chain, txSignature: async () => null }).tick();
      expect(((await sql`select signature from app.check_seals where agent_id = ${a.id}`) as { signature: string }[])[0]!.signature).toBe('');
      // Horizon down: the row stays empty for the next tick, and the tick still runs.
      await sql`update app.check_seals set signature = null where agent_id = ${a.id}`;
      await seals({ ...chain, txSignature: async () => { throw new Error('horizon 503'); } }).tick();
      expect(((await sql`select signature from app.check_seals where agent_id = ${a.id}`) as { signature: string | null }[])[0]!.signature).toBeNull();
    });

    it('a self-paying agent sends its seal unbumped; out of XLM, it asks the reserve worker for a float and retries', async () => {
      const a = await agent();
      await sql`update app.agents set reserve_state = 'self_paid', pays_own_fees = true where id = ${a.id}`;
      const sent: Transaction[] = [];
      let broke = true;
      const chain: SealChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        getAccount: async (id) => new Account(id, String(5_000n << 32n)),
        signSponsor: async () => {
          throw new Error('the sponsor must not pay');
        },
        submit: async (x) => {
          const tx = TransactionBuilder.fromXDR(x, P);
          if ('innerTransaction' in tx) throw new Error('fee-bumped');
          if (broke) throw new Error('chain: Horizon submit failed: 400 {"transaction":"tx_insufficient_balance"}');
          sent.push(tx as Transaction);
          return { hash: (tx as Transaction).hash().toString('hex') };
        },
      };
      const s = seals(chain);
      await s.enqueue(a.id, { held: true, reading: null, at: new Date(Date.now() - 1000) });
      expect(await s.tick()).toEqual({ sent: 0, retried: 1, failed: 0 });
      expect((await rows(a.id))[0]!.error).toBe('no_xlm');
      const [flag] = (await sql`select reserve_next_at is not null as asked from app.agents where id = ${a.id}`) as { asked: boolean }[];
      expect(flag!.asked).toBe(true);
      broke = false;
      await sql`update app.check_seals set next_at = now() where agent_id = ${a.id}`;
      expect(await s.tick()).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(sent[0]!.source).toBe(a.address);
      expect(Keypair.fromPublicKey(a.address).verify(sent[0]!.hash(), sent[0]!.signatures[0]!.signature())).toBe(true);
    });

    it('retries with a growing wait, then gives up and says so; the check itself never waited', async () => {
      const a = await agent();
      const { chain } = fakeChain({ fail: () => new Error('chain: Horizon submit failed: 400 Transaction Failed {"transaction":"tx_bad_seq"}') });
      const s = seals(chain);
      await s.enqueue(a.id, { held: false, reading: null });
      expect(await s.tick()).toEqual({ sent: 0, retried: 1, failed: 0 });
      const [r] = await rows(a.id);
      expect(r).toMatchObject({ status: 'pending', attempts: 1, error: 'bad_seq' });
      expect(await s.tick()).toEqual({ sent: 0, retried: 0, failed: 0 }); // not due yet
      expect([1, 2, 3, 10].map(retryDelayS)).toEqual([10, 20, 40, 900]);
      await sql`update app.check_seals set attempts = ${MAX_ATTEMPTS - 1}, next_at = now() where agent_id = ${a.id}`;
      expect(await s.tick()).toEqual({ sent: 0, retried: 0, failed: 1 });
      expect((await rows(a.id))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, tx_hash: null });
    });

    it('a failure re-reads the sequence; other agents go on; the kill switch pauses everything', async () => {
      const a = await agent();
      const b = await agent();
      const { chain, sent } = fakeChain({ fail: (n) => (n === 0 ? new Error('chain: Horizon submit failed: 504 ') : null) });
      const s = seals(chain);
      await s.enqueue(a.id, { held: false, reading: null });
      await s.enqueue(b.id, { held: false, reading: null });
      expect(await seals(chain, true).tick()).toEqual({ sent: 0, retried: 0, failed: 0 });
      const r = await s.tick();
      expect(r.sent + r.retried).toBe(2);
      expect(r.retried).toBe(1);
      expect(sent).toHaveLength(1);
      expect((await rows(a.id)).concat(await rows(b.id)).find((x) => x.status === 'pending')!.error).toBe('horizon_504');
    });

    it('an agent with no account yet queues nothing', async () => {
      const userId = await insertUser(sql, { ownerAddress: StrKey.encodeContract(randomBytes(32)) });
      const id = await insertAgent(sql, userId, { status: 'provisioning' });
      const { chain } = fakeChain();
      await seals(chain).enqueue(id, { held: false, reading: null });
      expect(await rows(id)).toEqual([]);
    });

    it('the vault refusing (a revoked agent) ends as failed, never sent', async () => {
      const a = await agent();
      const { chain, sent } = fakeChain();
      const s = seals(chain);
      await s.enqueue(a.id, { held: false, reading: null });
      await sql`update app.agents set status = 'revoked' where id = ${a.id}`;
      await sql`update app.check_seals set attempts = ${MAX_ATTEMPTS - 1} where agent_id = ${a.id}`;
      expect(await s.tick()).toEqual({ sent: 0, retried: 0, failed: 1 });
      expect((await rows(a.id))[0]).toMatchObject({ status: 'failed', error: 'vault_not_active' });
      expect(sent).toHaveLength(0);
    });
  });

  describe('activity', () => {
    it('the day row counts the sealed checks and links the newest; the owner downloads the day', async () => {
      const a = await agent();
      const { chain, sent } = fakeChain2();
      const s = createSeals({ sql, chain, signSeal: (x, y, z) => keys.signSeal(x, y, z), killed: () => false, log: () => undefined });
      await sql`insert into app.check_days (agent_id, day, quiet, fired, last_at) values (${a.id}, (now() at time zone 'utc')::date, 3, 0, now())`;
      for (let i = 0; i < 3; i++) await s.enqueue(a.id, { held: false, reading: null, at: new Date(Date.now() - (3 - i) * 1000) });
      await s.tick();
      await sql`update app.check_seals set status = 'failed', tx_hash = null, sent_at = null where id = (select max(id) from app.check_seals where agent_id = ${a.id})`;
      const activity = createActivity(sql, { publicBaseUrl: 'https://x.test', seals: s });
      const feed = await activity.feed(a.userId, a.id, {});
      const quiet = feed.find((f) => f.type === 'quiet') as { seals?: { total: number; sent: number; failed: number; last: { hash: string } | null } };
      expect(quiet.seals).toMatchObject({ total: 3, sent: 2, failed: 1 });
      expect(quiet.seals!.last!.hash).toBe(sent[1]!.hash);
      const day = new Date().toISOString().slice(0, 10);
      const list = await activity.seals(a.userId, a.id, day);
      expect(list.map((r) => r.status)).toEqual(['sent', 'sent', 'failed']);
      expect(list.every((r) => sha(r.document) === r.digest)).toBe(true);
      const other = await agent();
      expect(await activity.seals(other.userId, other.id, day)).toEqual([]);
      expect(await activity.seals(other.userId, a.id, day).then(() => 'ok', (e: { status?: number }) => e.status)).toBe(404);
      expect(await activity.seals(a.userId, a.id, 'nope')).toEqual([]);
    });

    it('a finished mission seals its decision with every payment it made, on any chain, once', async () => {
      const a = await agent();
      const { chain, sent } = fakeChain2();
      const s = createSeals({ sql, chain, signSeal: (x, y, z) => keys.signSeal(x, y, z), killed: () => false, log: () => undefined });
      const [run] = (await sql`insert into app.runs (agent_id, mode, status, summary, steps, ended_at)
                               values (${a.id}, 'mission', 'done', 'Bought the dip.', ${[{ n: 1, tools: ['market_price', 'hire_agent'] }, { n: 2, tools: ['hire_agent'] }]}, now())
                               returning id`) as { id: string }[];
      const stellarTx = 'a1'.repeat(32);
      const baseTx = 'b2'.repeat(32);
      const payee = G();
      const evmPayee = `0x${'cd'.repeat(20)}`;
      await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, tx_hash, decision, network) values
                (${a.id}, ${run!.id}, 'https://s.test', ${payee}, 0.01, ${stellarTx}, 'settled', 'stellar:testnet'),
                (${a.id}, ${run!.id}, 'https://e.test', ${evmPayee}, 0.02, ${baseTx}, 'settled', 'eip155:84532'),
                (${a.id}, ${run!.id}, 'https://f.test', ${payee}, 0.03, null, 'failed', 'stellar:testnet')`;
      const input = 'XLM fell 5.8% in an hour. Buy if under $0.19.';
      await s.enqueueDecision(a.id, { runId: run!.id, status: 'done', input, output: 'Bought.' });
      await s.enqueueDecision(a.id, { runId: run!.id, status: 'done', input, output: 'Bought.' }); // once per run
      const rows = (await sql`select kind, run_id, document, digest from app.check_seals where agent_id = ${a.id}`) as { kind: string; run_id: string; document: string; digest: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('decision');
      expect(sha(rows[0]!.document)).toBe(rows[0]!.digest);
      const d = parseDecision(rows[0]!.document)!;
      expect(d).toMatchObject({ v: DECISION_VERSION, agent: a.address, runId: run!.id, status: 'done', input: sha(input), output: sha('Bought.'), steps: ['market_price', 'hire_agent', 'hire_agent'] });
      expect(d.txs).toEqual([
        { network: 'stellar:testnet', tx: stellarTx, usdc: '0.0100000', to: payee },
        { network: 'eip155:84532', tx: baseTx, usdc: '0.0200000', to: evmPayee },
      ]);
      expect(document_has_no_text(rows[0]!.document, input)).toBe(true);

      await s.tick();
      const activity = createActivity(sql, { publicBaseUrl: 'https://x.test', seals: s });
      const alert = (await activity.feed(a.userId, a.id, {})).find((f) => f.type === 'alert') as { decision?: { status: string; tx: { hash: string; network: string } | null } };
      expect(alert.decision).toEqual({ status: 'sent', tx: { hash: sent[0]!.hash, network: 'stellar:testnet' } });
      // The check counts stay checks only.
      expect((await s.days(a.id, new Date(Date.now() - 86_400_000)))).toEqual([]);
    });

    it('a decision document refuses what it cannot carry exactly', () => {
      const base: DecisionDocument = { v: DECISION_VERSION, network: 'stellar:testnet', agent: G(), agentId: null, at: '2026-10-29T12:00:00.000Z', runId: '0b1c2d3e-0000-4000-8000-000000000000', status: 'done', input: sha('i'), output: null, steps: [], txs: [], salt: 'ab'.repeat(16) };
      expect(parseDecision(decisionBytes(base))).toEqual(base);
      expect(() => decisionBytes({ ...base, steps: ['Bad Tool'] })).toThrow();
      expect(() => decisionBytes({ ...base, txs: [{ network: 'eip155:84532', tx: `0x${'a'.repeat(64)}`, usdc: '1', to: G() }] })).toThrow();
      expect(() => decisionBytes({ ...base, runId: 'x' })).toThrow();
    });

    function fakeChain2() {
      const sent: { hash: string }[] = [];
      let seq = 9_000n << 32n;
      const chain: SealChain = {
        sponsorPublicKey: sponsorKp.publicKey(),
        getAccount: async (id) => new Account(id, String(seq)),
        signSponsor: (x, p) => keys.sponsorSigner(sponsorKp.publicKey()).signTransaction(x, p),
        submit: async (x) => {
          const fb = TransactionBuilder.fromXDR(x, P) as FeeBumpTransaction;
          seq = BigInt(fb.innerTransaction.sequence);
          const hash = fb.hash().toString('hex');
          sent.push({ hash });
          return { hash };
        },
      };
      return { chain, sent };
    }
  });
});

