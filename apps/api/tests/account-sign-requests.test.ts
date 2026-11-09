import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { createSignRequests, type SignRequestInput } from '../src/account/sign-requests.js';
import type { Db } from '../src/db/index.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { SQL } from 'bun';
import { INSTANCE_CLASS } from '../src/db/index.js';
import { authEntry, b64, scv, signEntry } from './support/entries.js';
import { contractAddress, insertAgent, insertUser } from './support/fixtures.js';

const sponsor = Keypair.random().publicKey();
const latestLedger = async () => 5000;
let ownerSeq = 10; // owner_address is unique per user, so every test gets its own owner
const registerEntry = (ownerC: string) => authEntry({ signer: ownerC, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str('https://public.example.test/a/x/agent.json')] });

describe('sign requests', () => {
  let sql: Db;
  let url: string;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, url, drop } = await freshDb()));
  afterAll(() => drop());

  async function setup() {
    const ownerC = contractAddress(ownerSeq++);
    const agentG = Keypair.random().publicKey(); // agents.stellar_address is unique too
    const userId = await insertUser(sql, { ownerAddress: ownerC });
    const agentId = await insertAgent(sql, userId, { stellarAddress: agentG });
    const entry = registerEntry(ownerC);
    const input: SignRequestInput = { userId, agentId, kind: 'register', entryXdr: b64(entry), validUntilLedger: 5100, networkPassphrase: TESTNET.passphrase };
    return { userId, agentId, entry, input, ownerC, agentG };
  }
  const firstPending = async (sr: ReturnType<typeof createSignRequests>, userId: string) => {
    for (let i = 0; i < 50; i++) {
      const p = await sr.pending(userId);
      if (p.length) return p[0]!;
      await Bun.sleep(10);
    }
    throw new Error('no pending request appeared');
  };

  it('request → pending (with source and agent wallet) → sign → request resolves with the signed entry', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, agentId, entry, input, agentG } = await setup();
    const waiting = sr.request(input);
    const pending = await firstPending(sr, userId);
    expect(pending).toMatchObject({ kind: 'register', agentId, entryXdr: input.entryXdr, validUntilLedger: 5100, networkPassphrase: TESTNET.passphrase, source: sponsor, agentWallet: agentG });
    const signed = b64(signEntry(entry, 5100));
    await sr.sign(userId, pending.id, signed);
    expect(await waiting).toBe(signed);
    expect(await sr.pending(userId)).toEqual([]);
    await expect(sr.sign(userId, pending.id, signed)).rejects.toMatchObject({ status: 409, code: 'not_pending' });
  });

  it('reject → request throws owner_rejected', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, input } = await setup();
    const waiting = sr.request(input).catch((e: Error & { code?: string }) => [e.message, e.code]);
    await sr.reject(userId, (await firstPending(sr, userId)).id);
    expect(await waiting).toEqual(['sign_request: owner_rejected', 'owner_rejected']);
  });

  it('expiry → request throws owner_timeout; the row is expired and can no longer be signed', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 5, ttlMs: 60, latestLedger });
    const { userId, entry, input } = await setup();
    const waiting = sr.request(input).catch((e: Error & { code?: string }) => [e.message, e.code]);
    expect(await waiting).toEqual(['sign_request: owner_timeout', 'owner_timeout']);
    // Read the row directly: a 60 ms TTL is gone before pending() can see it over a remote test DB.
    const [row] = (await sql`select id, status from app.sign_requests where user_id = ${userId}`) as { id: string; status: string }[];
    expect(row!.status).toBe('expired');
    await expect(sr.sign(userId, row!.id, b64(signEntry(entry, 5100)))).rejects.toMatchObject({ status: 409 });
  });

  it('recovery: expireOrphaned expires pending rows of dead (or no) instances, never a live instance\'s, and leaves answered rows alone', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    // A live replica: its instance lock is held on a session of its own.
    const live = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 });
    await live`select pg_advisory_lock(${INSTANCE_CLASS}::int4, 4242::int4)`;
    const srLive = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger, instance: 4242 });
    const a = await setup();
    const b = await setup();
    const c = await setup();
    const waiting = sr.request(a.input).catch((e: Error & { code?: string }) => e.code);
    const pendingA = await firstPending(sr, a.userId);
    const signedB = sr.request(b.input);
    const pendingB = await firstPending(sr, b.userId);
    await sr.sign(b.userId, pendingB.id, b64(signEntry(b.entry, 5100)));
    await signedB;
    const waitingC = srLive.request(c.input);
    const pendingC = await firstPending(srLive, c.userId);
    expect(await sr.expireOrphaned()).toBeGreaterThanOrEqual(1);
    const rows = (await sql`select id, status from app.sign_requests where id in (${pendingA.id}, ${pendingB.id}, ${pendingC.id})`) as { id: string; status: string }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect([by[pendingA.id], by[pendingB.id], by[pendingC.id]]).toEqual(['expired', 'signed', 'pending']);
    expect(await waiting).toBe('owner_timeout');
    expect(await sr.pending(a.userId)).toEqual([]);
    await srLive.sign(c.userId, pendingC.id, b64(signEntry(c.entry, 5100)));
    await waitingC;
    await live.close();
  });

  it('another user can neither see, sign nor reject it (404)', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, entry, input } = await setup();
    const other = await insertUser(sql);
    void sr.request(input).catch(() => undefined);
    const pending = await firstPending(sr, userId);
    expect(await sr.pending(other)).toEqual([]);
    await expect(sr.sign(other, pending.id, b64(signEntry(entry, 5100)))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(sr.reject(other, pending.id)).rejects.toMatchObject({ status: 404 });
    await sr.reject(userId, pending.id);
  });

  it('a signed entry that differs from the request is refused (400) and the request stays pending', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, entry, input, ownerC } = await setup();
    void sr.request(input).catch(() => undefined);
    const { id } = await firstPending(sr, userId);
    const otherCall = signEntry(authEntry({ signer: ownerC, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str('https://evil.example')] }), 5100);
    const otherNonce = signEntry(authEntry({ signer: ownerC, nonce: 1, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str('https://public.example.test/a/x/agent.json')] }), 5100);
    const wrongExpiry = signEntry(entry, 9999);
    for (const bad of [b64(entry) /* unsigned */, b64(otherCall), b64(otherNonce), b64(wrongExpiry), 'AAAA']) {
      await expect(sr.sign(userId, id, bad)).rejects.toMatchObject({ status: 400, code: 'entry_mismatch' });
    }
    expect((await sr.pending(userId)).map((p) => p.id)).toEqual([id]);
    await sr.reject(userId, id);
  });

  it('bounds validUntilLedger to latest < v <= latest + 102, refusing before any row exists', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, input } = await setup();
    await expect(sr.request({ ...input, validUntilLedger: 5103 })).rejects.toMatchObject({ message: 'sign_request: validity_too_long', code: 'validity_too_long' });
    await expect(sr.request({ ...input, validUntilLedger: 5000 })).rejects.toMatchObject({ message: 'sign_request: already_expired', code: 'already_expired' });
    await expect(sr.request({ ...input, validUntilLedger: 4000 })).rejects.toMatchObject({ message: 'sign_request: already_expired', code: 'already_expired' });
    expect(await sr.pending(userId)).toEqual([]);
    for (const v of [5001, 5102]) {
      void sr.request({ ...input, validUntilLedger: v }).catch(() => undefined);
      await sr.reject(userId, (await firstPending(sr, userId)).id);
    }
  });

  it('expires_at is capped by the ledger window: 3 ledgers left means at most 15 s, not the 300 s ttl', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, input } = await setup();
    void sr.request({ ...input, validUntilLedger: 5003 }).catch(() => undefined);
    const { id } = await firstPending(sr, userId);
    const [r] = (await sql`select extract(epoch from (expires_at - now())) as left from app.sign_requests where id = ${id}`) as { left: string }[];
    expect(Number(r!.left)).toBeLessThanOrEqual(15);
    expect(Number(r!.left)).toBeGreaterThan(10);
    await sr.reject(userId, id);
  });

  it('accepts a shorter (clamped) expiry, but never a zero one or a longer one', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, entry, input } = await setup();
    void sr.request(input).catch(() => undefined);
    const { id } = await firstPending(sr, userId);
    await expect(sr.sign(userId, id, b64(signEntry(entry, 0)))).rejects.toMatchObject({ status: 400, code: 'entry_mismatch' });
    await expect(sr.sign(userId, id, b64(signEntry(entry, 5101)))).rejects.toMatchObject({ status: 400, code: 'entry_mismatch' });
    await sr.sign(userId, id, b64(signEntry(entry, 5012)));
    const [row] = (await sql`select status from app.sign_requests where id = ${id}`) as { status: string }[];
    expect(row!.status).toBe('signed');
  });

  it('fails fast at insert: entry signer is not the owner, user has no owner, or agent belongs to someone else', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const userId = await insertUser(sql, { ownerAddress: contractAddress(ownerSeq++) });
    const agentId = await insertAgent(sql, userId, { stellarAddress: Keypair.random().publicKey() });
    const mk = (u: string, a: string, signer: string) => ({ userId: u, agentId: a, kind: 'register' as const, entryXdr: b64(registerEntry(signer)), validUntilLedger: 5100, networkPassphrase: TESTNET.passphrase });
    await expect(sr.request(mk(userId, agentId, contractAddress(ownerSeq++)))).rejects.toMatchObject({ message: 'sign_request: signer_not_owner', code: 'signer_not_owner' });
    const noOwner = await insertUser(sql);
    const noOwnerAgent = await insertAgent(sql, noOwner, { stellarAddress: Keypair.random().publicKey() });
    await expect(sr.request(mk(noOwner, noOwnerAgent, contractAddress(ownerSeq++)))).rejects.toMatchObject({ message: 'sign_request: signer_not_owner', code: 'signer_not_owner' });
    const owner = (await sql`select owner_address from app.users where id = ${userId}`) as { owner_address: string }[];
    await expect(sr.request(mk(userId, noOwnerAgent, owner[0]!.owner_address))).rejects.toMatchObject({ message: 'sign_request: agent_not_owned', code: 'agent_not_owned' });
    await expect(sr.request(mk(userId, crypto.randomUUID(), owner[0]!.owner_address))).rejects.toMatchObject({ message: 'sign_request: agent_not_owned', code: 'agent_not_owned' });
    expect(await sr.pending(userId)).toEqual([]);
  });

  it('a malformed id is a 404, not a database error', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, latestLedger });
    const { userId, entry } = await setup();
    await expect(sr.sign(userId, 'not-a-uuid', b64(signEntry(entry, 5100)))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(sr.reject(userId, 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
  });

  /** Both callers read a live row before either one writes: the barrier makes the race deterministic. */
  // The barrier forced expires_at into the past; wait until the background request's poll marks the row expired.
  const untilExpired = async (id: string) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await Bun.sleep(20)) {
      const [row] = (await sql`select status from app.sign_requests where id = ${id}`) as { status: string }[];
      if (row?.status === 'expired') return;
    }
    throw new Error('sign request was not marked expired');
  };

  function barrierDb(id: string, expire: boolean): Db {
    let reads = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    return new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const q = Reflect.apply(target, thisArg, args) as Promise<unknown>;
        const strings = args[0] as readonly string[] | undefined;
        if (Array.isArray(strings) && strings.join('?').includes('join app.users')) {
          return q.then(async (r) => {
            if (expire) await sql`update app.sign_requests set expires_at = now() - interval '1 second' where id = ${id}`;
            else if (++reads === 2) release();
            if (!expire) await both;
            return r;
          });
        }
        return q;
      },
    }) as Db;
  }

  it('a bind request exposes the register tx hash it was given; a register request exposes null', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 2000, latestLedger });
    const { userId, input } = await setup();
    void sr.request(input).catch(() => undefined);
    expect((await firstPending(sr, userId)).registerTx).toBeNull();

    const b = await setup();
    const registerTx = 'd'.repeat(64);
    void sr.request({ ...b.input, kind: 'bind', registerTx }).catch(() => undefined);
    expect(await firstPending(sr, b.userId)).toMatchObject({ kind: 'bind', registerTx });
  });

  it('a register tx hash that is not 64 lowercase hex is never stored', async () => {
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 2000, latestLedger });
    const { input } = await setup();
    await expect(sr.request({ ...input, kind: 'bind', registerTx: 'not-a-hash' })).rejects.toMatchObject({ errno: '23514' }); // check_violation
    expect(await sr.pending(input.userId)).toEqual([]);
  });

  it('a sign that loses the race to expiry is refused (409) and nothing is recorded', async () => {
    const { userId, entry, input } = await setup();
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 5000, latestLedger });
    void sr.request(input).catch(() => undefined);
    const { id } = await firstPending(sr, userId);
    const sr2 = createSignRequests(barrierDb(id, true), { source: sponsor, pollMs: 10, latestLedger });
    await expect(sr2.sign(userId, id, b64(signEntry(entry, 5100)))).rejects.toMatchObject({ status: 409, code: 'not_pending' });
    const [row] = (await sql`select signed_entry_xdr from app.sign_requests where id = ${id}`) as { signed_entry_xdr: string | null }[];
    expect(row!.signed_entry_xdr).toBeNull();
    await untilExpired(id); // let the background request finish before the next test
  });

  it('a reject that loses the race to expiry is refused (409)', async () => {
    const { userId, input } = await setup();
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 5000, latestLedger });
    void sr.request(input).catch(() => undefined);
    const { id } = await firstPending(sr, userId);
    const sr2 = createSignRequests(barrierDb(id, true), { source: sponsor, pollMs: 10, latestLedger });
    await expect(sr2.reject(userId, id)).rejects.toMatchObject({ status: 409, code: 'not_pending' });
    await untilExpired(id);
  });

  it('two signs racing: exactly one wins, the other gets 409', async () => {
    const { userId, entry, input } = await setup();
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 2000, latestLedger });
    const waiting = sr.request(input).catch(() => 'x');
    const { id } = await firstPending(sr, userId);
    const racing = createSignRequests(barrierDb(id, false), { source: sponsor, pollMs: 10, latestLedger });
    const a = b64(signEntry(entry, 5100));
    const b = b64(signEntry(entry, 5099));
    const res = await Promise.allSettled([racing.sign(userId, id, a), racing.sign(userId, id, b)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: 'not_pending' });
    const winner = res[0]!.status === 'fulfilled' ? a : b;
    expect(await waiting).toBe(winner);
  });

  it('sign racing reject: exactly one wins, the other gets 409, and the request outcome matches', async () => {
    const { userId, entry, input } = await setup();
    const sr = createSignRequests(sql, { source: sponsor, pollMs: 10, ttlMs: 2000, latestLedger });
    const waiting = sr.request(input).catch((e: Error) => e.message);
    const { id } = await firstPending(sr, userId);
    const racing = createSignRequests(barrierDb(id, false), { source: sponsor, pollMs: 10, latestLedger });
    const s = b64(signEntry(entry, 5100));
    const res = await Promise.allSettled([racing.sign(userId, id, s), racing.reject(userId, id)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await waiting).toBe(res[0]!.status === 'fulfilled' ? s : 'sign_request: owner_rejected');
  });
});
