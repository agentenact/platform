import { describe, expect, it, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { PUBLIC } from '@/lib/public-config';
import { processPending, type Approval, type ApprovalStore, type PublicSignRequest, type SigningDeps } from '@/lib/signing-flow';
import { TESTNET } from '@/mirror/owner-client/testnet';
import { authEntry, b64, contractAddress, fakeChain, invocation, REGISTER_TX, scv, walletSpy } from './support/owner-chain';

const ownerC = contractAddress(7);
const sponsor = Keypair.random().publicKey();
const agentG = Keypair.random().publicKey();
const uri = `${PUBLIC.uriPrefix}0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e/agent.json`;

const baseReq = (over: Partial<PublicSignRequest>): PublicSignRequest => ({
  id: 'r1',
  kind: 'register',
  agentId: '0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e',
  entryXdr: '',
  validUntilLedger: 5100,
  networkPassphrase: TESTNET.passphrase,
  expiresAt: '2026-10-12T12:05:00.000Z',
  source: sponsor,
  agentWallet: agentG,
  registerTx: null,
  ...over,
});
const registerEntry = (signer = ownerC, sub: Parameters<typeof authEntry>[0]['sub'] = []) =>
  authEntry({ signer, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str(uri)], sub });
const registerReq = (over: Partial<PublicSignRequest> = {}) => baseReq({ entryXdr: b64(registerEntry()), ...over });
const bindEntry = (wallet = agentG) => authEntry({ signer: ownerC, fn: 'set_agent_wallet', args: [scv.addr(ownerC), scv.u32(42), scv.addr(wallet)] });
const bindReq = (over: Partial<PublicSignRequest> = {}) => baseReq({ id: 'r2', kind: 'bind', entryXdr: b64(bindEntry()), ...over });

function memoryStore(initial: { approval: Approval; txHash?: string } | null = null): ApprovalStore & { sets: number } {
  let v = initial;
  const s = { sets: 0, getRegistered: () => v, setRegistered: (n: { approval: Approval; txHash?: string }) => ((v = n), s.sets++), clearRegistered: () => void (v = null) };
  return s;
}

/** All doors of the flow as spies, in one ordered event log. */
function harness(requests: PublicSignRequest[], o: { store?: ApprovalStore; simFails?: boolean; confirmAnswer?: 'yes' | 'later' | 'stop'; rpcWrap?: (r: SigningDeps['rpc']) => SigningDeps['rpc']; postFails?: boolean | Error } = {}) {
  const events: string[] = [];
  const store = (o.store ?? memoryStore()) as ApprovalStore & { sets: number };
  const confirms: { kind: string; summary: string }[] = [];
  const posted: { id: string; xdr: string }[] = [];
  const rejected: string[] = [];
  const chain = fakeChain({ owner: ownerC, sponsor, uri, registered: () => store.getRegistered()?.approval ?? null, simFails: o.simFails });
  const w = walletSpy(ownerC);
  const wallet = { address: w.address, signEntry: async (x: string, v: number) => (events.push('sign'), w.signEntry(x, v)) };
  const deps: SigningDeps = {
    listPending: async () => requests,
    post: async (id, x) => {
      if (o.postFails) throw o.postFails === true ? new Error('503') : o.postFails;
      events.push('post');
      posted.push({ id, xdr: x });
    },
    reject: async (id) => void (events.push('reject'), rejected.push(id)),
    wallet,
    rpc: o.rpcWrap ? o.rpcWrap(chain.rpc) : chain.rpc,
    confirm: async (kind, summary) => (events.push('confirm'), confirms.push({ kind, summary }), o.confirmAnswer ?? 'yes'),
    store,
    uriPrefix: PUBLIC.uriPrefix,
  };
  return { deps, events, store, confirms, posted, rejected, chain, wallet: w };
}

describe('the signing gate refuses what the server crafts', () => {
  test('a server-crafted USDC transfer from the owner\'s wallet to another address is refused: signEntry, confirm and post are never called, reject is', async () => {
    const transfer = authEntry({ signer: ownerC, contract: TESTNET.usdcSac, fn: 'transfer', args: [scv.addr(ownerC), scv.addr(agentG), scv.i128(10_000_000n)] });
    const h = harness([registerReq({ entryXdr: b64(transfer) })]);
    const out = await processPending(h.deps);
    expect(out.signed).toBe(0);
    expect(out.refused).toEqual([{ id: 'r1', reason: `calls ${TESTNET.usdcSac}, not the identity registry`, outcome: 'refused' }]);
    expect(h.wallet.prompts).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.rejected).toEqual(['r1']);
    expect(h.chain.simulated).toEqual([]);
  });

  test('set_agent_wallet binding a wallet other than the agent\'s is refused', async () => {
    const h = harness([registerReq(), bindReq({ entryXdr: b64(bindEntry(Keypair.random().publicKey())), registerTx: REGISTER_TX })]);
    const out = await processPending(h.deps);
    expect(out.signed).toBe(1); // the register
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]!.id).toBe('r2');
    expect(out.refused[0]!.reason).toMatch(/binds a different wallet/);
    expect(h.rejected).toEqual(['r2']);
    expect(h.wallet.prompts).toBe(1);
  });

  test('an entry with a nested sub-invocation is refused', async () => {
    const usdcTransfer = invocation(TESTNET.usdcSac, 'transfer', [scv.addr(ownerC), scv.addr(agentG), scv.i128(10_000_000n)]);
    const h = harness([baseReq({ entryXdr: b64(registerEntry(ownerC, [usdcTransfer])) })]);
    const out = await processPending(h.deps);
    expect(out.refused).toEqual([{ id: 'r1', reason: 'authorises nested calls', outcome: 'refused' }]);
    expect([h.wallet.prompts, h.confirms.length, h.posted.length]).toEqual([0, 0, 0]);
    expect(h.rejected).toEqual(['r1']);
  });

  test('an entry naming another signer than the owner is refused', async () => {
    const other = contractAddress(9);
    const h = harness([baseReq({ entryXdr: b64(registerEntry(other)) })]);
    const out = await processPending(h.deps);
    expect(out.refused).toEqual([{ id: 'r1', reason: `asks ${other} to sign, not your wallet`, outcome: 'refused' }]);
    expect([h.wallet.prompts, h.confirms.length, h.posted.length]).toEqual([0, 0, 0]);
    expect(h.rejected).toEqual(['r1']);
  });

  test('a bind with no stored registration is refused, and one supplied only by the server (a registerTx pointer) is refused', async () => {
    const bare = harness([bindReq()]);
    expect((await processPending(bare.deps)).refused).toEqual([{ id: 'r2', reason: 'there is no registration you approved to bind', outcome: 'refused' }]);
    const pointer = harness([bindReq({ registerTx: REGISTER_TX })]);
    expect((await processPending(pointer.deps)).refused).toEqual([{ id: 'r2', reason: 'there is no registration you approved to bind', outcome: 'refused' }]);
    for (const h of [bare, pointer]) {
      expect(h.rejected).toEqual(['r2']);
      expect([h.wallet.prompts, h.confirms.length, h.posted.length, h.chain.txReads.length]).toEqual([0, 0, 0, 0]);
    }
  });

  test('a simulation failure refuses before confirm', async () => {
    const h = harness([registerReq()], { simFails: true });
    const out = await processPending(h.deps);
    expect(out.refused[0]!.reason).toMatch(/^the network rejects this call/);
    expect(h.events).toEqual(['reject']);
  });
});

describe('the signing gate tells an unavailable chain from a refusal', () => {
  const lagging = (r: SigningDeps['rpc']): SigningDeps['rpc'] => ({
    ...r,
    getTransaction: async (hash: string) => ({ ...(await r.getTransaction(hash)), status: 'NOT_FOUND' }) as never,
  });

  it('an RPC that lags (registration not on chain yet) leaves the request pending, never rejected', async () => {
    const h = harness([registerReq(), bindReq({ registerTx: REGISTER_TX })], { rpcWrap: lagging });
    const out = await processPending(h.deps);
    expect(out.signed).toBe(1);
    expect(out.refused).toEqual([{ id: 'r2', reason: 'the registration is not on chain yet', outcome: 'retry' }]);
    expect(h.rejected).toEqual([]);
    expect(h.posted.map((p) => p.id)).toEqual(['r1']);
    expect(h.wallet.prompts).toBe(1);
  });

  it('a transport error on simulation leaves the request pending', async () => {
    const h = harness([registerReq()], {
      rpcWrap: (r) => ({ ...r, simulateTransaction: async () => { throw new Error('network down'); } }),
    });
    const out = await processPending(h.deps);
    expect(out).toEqual({ signed: 0, refused: [{ id: 'r1', reason: 'simulation unavailable', outcome: 'retry' }] });
    expect(h.rejected).toEqual([]);
    expect(h.wallet.prompts).toBe(0);
  });

  it('a policy refusal still rejects at once', async () => {
    const h = harness([registerReq({ networkPassphrase: 'Some Other Network' })]);
    const out = await processPending(h.deps);
    expect(out.refused).toEqual([{ id: 'r1', reason: 'wrong network', outcome: 'refused' }]);
    expect(h.rejected).toEqual(['r1']);
  });

  it('a failed post leaves the request pending and does not reject it', async () => {
    const h = harness([registerReq()], { postFails: true });
    const out = await processPending(h.deps);
    expect(out).toEqual({ signed: 0, refused: [{ id: 'r1', reason: 'could not send the signature', outcome: 'retry' }] });
    expect(h.rejected).toEqual([]);
  });

  it('a wallet that throws the kit ValidationError rejects the request', async () => {
    const h = harness([registerReq()]);
    h.deps.wallet = { address: ownerC, signEntry: async () => { throw Object.assign(new Error('not for this account'), { name: 'ValidationError' }); } };
    const out = await processPending(h.deps);
    expect(out.refused[0]).toMatchObject({ id: 'r1', outcome: 'refused' });
    expect(h.rejected).toEqual(['r1']);
  });

  it('any other wallet error leaves the request pending to retry', async () => {
    const h = harness([registerReq()]);
    h.deps.wallet = { address: ownerC, signEntry: async () => { throw new Error('Failed to fetch context rule 0'); } };
    const out = await processPending(h.deps);
    expect(out.refused[0]).toMatchObject({ id: 'r1', outcome: 'retry' });
    expect(h.rejected).toEqual([]);
  });

  it('a bind does not overwrite the stored registration, and spends it once delivered', async () => {
    const h = harness([registerReq(), bindReq({ registerTx: REGISTER_TX })]);
    await processPending(h.deps);
    expect(h.store.sets).toBe(1);
    expect(h.store.getRegistered()).toBeNull();
  });

  it('a bind ignores a stored registration of another agent', async () => {
    const h = harness([registerReq()]);
    await processPending(h.deps);
    const other = harness([bindReq({ agentId: 'some-other-agent', registerTx: REGISTER_TX })], { store: h.store });
    const out = await processPending(other.deps);
    expect(out.refused).toEqual([{ id: 'r2', reason: 'there is no registration you approved to bind', outcome: 'refused' }]);
    expect(other.rejected).toEqual(['r2']);
  });

  it('a storage failure on the register approval is reported and nothing is sent', async () => {
    const store = { ...memoryStore(), setRegistered: () => { throw new Error('quota'); } };
    const h = harness([registerReq(), registerReq({ id: 'r9' })], { store });
    const out = await processPending(h.deps);
    expect(out.signed).toBe(0);
    expect(out.refused.map((r) => r.id)).toEqual(['r1', 'r9']);
    expect(h.posted).toEqual([]);
  });

  it('a request already being processed is not prompted twice', async () => {
    const h = harness([registerReq()]);
    const [a, b] = await Promise.all([processPending(h.deps), processPending(h.deps)]);
    expect(a.signed + b.signed).toBe(1);
    expect(h.wallet.prompts).toBe(1);
  });

  it('a request held by another tab is skipped, not signed', async () => {
    const g = globalThis as { navigator?: unknown };
    const orig = Object.getOwnPropertyDescriptor(g, 'navigator');
    const asked: string[] = [];
    Object.defineProperty(g, 'navigator', { configurable: true, value: { locks: { request: async (name: string, _o: unknown, cb: (l: unknown) => Promise<void>) => (asked.push(name), cb(null)) } } });
    try {
      const h = harness([registerReq()]);
      const out = await processPending(h.deps);
      expect(asked).toEqual(['ae-sign:r1']);
      expect(out.signed).toBe(0);
      expect(out.refused).toEqual([{ id: 'r1', reason: 'in another tab', outcome: 'other_tab' }]);
      expect(h.wallet.prompts).toBe(0);
      expect(h.posted).toEqual([]);
      expect(h.rejected).toEqual([]);
    } finally {
      if (orig) Object.defineProperty(g, 'navigator', orig);
      else delete g.navigator;
    }
  });

  it('a definitive entry_mismatch restores the previous approval', async () => {
    const first = harness([registerReq()]);
    await processPending(first.deps);
    const prev = first.store.getRegistered();
    expect(prev).not.toBeNull();
    const mismatch = Object.assign(new Error('api'), { status: 400, code: 'entry_mismatch' });
    const h = harness([registerReq({ id: 'r7' })], { store: first.store, postFails: mismatch });
    const out = await processPending(h.deps);
    expect(out.refused).toEqual([{ id: 'r7', reason: 'could not send the signature', outcome: 'retry' }]);
    expect(h.store.getRegistered()).toBe(prev);
    // and with nothing stored before, a rejected post leaves nothing behind
    const empty = harness([registerReq()], { postFails: mismatch });
    await processPending(empty.deps);
    expect(empty.store.getRegistered()).toBeNull();
  });

  it('a lost response after a delivered register keeps the approval so the bind can proceed', async () => {
    const store = memoryStore();
    // The server records the signature, then the response is lost: post throws on the client after it was delivered.
    const lost = harness([registerReq()], { store, postFails: Object.assign(new Error('api'), { status: 502 }) });
    const out = await processPending(lost.deps);
    expect(out.refused).toEqual([{ id: 'r1', reason: 'could not send the signature', outcome: 'retry' }]);
    expect(store.getRegistered()).not.toBeNull();
    // The register tx went out with that entry; the bind finds its approval and signs.
    const bind = harness([bindReq({ registerTx: REGISTER_TX })], { store });
    const res = await processPending(bind.deps);
    expect(res.signed).toBe(1);
    expect(bind.rejected).toEqual([]);
    expect(store.getRegistered()).toBeNull();
  });
});

describe('the signing gate signs what it understands', () => {
  test('a well-formed register request calls confirm once with kind register, then signEntry once, then post, and stores the approval', async () => {
    const h = harness([registerReq()]);
    const out = await processPending(h.deps);
    expect(out).toEqual({ signed: 1, refused: [] });
    expect(h.events).toEqual(['confirm', 'sign', 'post']);
    expect(h.confirms).toEqual([{ kind: 'register', summary: `Create a new agent identity owned by your wallet, described at ${uri}.` }]);
    expect(h.posted).toHaveLength(1);
    const stored = h.store.getRegistered();
    expect(stored?.approval.signedEntryXdr).toBe(h.posted[0]!.xdr);
    expect(stored?.approval.call).toEqual({ fn: 'register_with_uri', owner: ownerC, agentUri: uri });
  });

  test('a bind after a register in the same pass reads the registration from browser storage and the agent id from the chain', async () => {
    const h = harness([registerReq(), bindReq({ registerTx: REGISTER_TX })]);
    const out = await processPending(h.deps);
    expect(out).toEqual({ signed: 2, refused: [] });
    expect(h.confirms.map((c) => c.kind)).toEqual(['register', 'bind']);
    expect(h.confirms[1]!.summary).toBe(`Let agent #42 act with its own wallet ${agentG}.`);
    expect(h.chain.txReads).toEqual([REGISTER_TX]);
    expect(h.rejected).toEqual([]);
  });

  test('"Not now" signs nothing and leaves the request pending (cancelled); "Stop" rejects it (refused)', async () => {
    const later = harness([registerReq()], { confirmAnswer: 'later' });
    const out = await processPending(later.deps);
    expect(out).toEqual({ signed: 0, refused: [{ id: 'r1', reason: 'not now', outcome: 'cancelled' }] });
    expect(later.events).toEqual(['confirm']);
    expect(later.rejected).toEqual([]);
    expect(later.wallet.prompts).toBe(0);
    expect(later.store.getRegistered()).toBeNull();

    const stop = harness([registerReq()], { confirmAnswer: 'stop' });
    const out2 = await processPending(stop.deps);
    expect(out2).toEqual({ signed: 0, refused: [{ id: 'r1', reason: 'you declined', outcome: 'refused' }] });
    expect(stop.events).toEqual(['confirm', 'reject']);
    expect(stop.wallet.prompts).toBe(0);
    expect(stop.store.getRegistered()).toBeNull();
  });

  test('a closed passkey prompt (NotAllowedError, bare or as a cause) is cancelled and the request stays pending', async () => {
    for (const err of [Object.assign(new Error('timed out or not allowed'), { name: 'NotAllowedError' }), Object.assign(new Error('wrapped'), { cause: new DOMException('x', 'NotAllowedError') })]) {
      const h = harness([registerReq()]);
      let t = 0;
      h.deps.now = () => t;
      h.deps.wallet = { address: ownerC, signEntry: async () => ((t += 4000), Promise.reject(err)) }; // the prompt was open for 4 s
      const out = await processPending(h.deps);
      expect(out.refused.map((r) => r.outcome)).toEqual(['cancelled']);
      expect(h.rejected).toEqual([]);
      expect(h.posted).toEqual([]);
      expect(h.store.getRegistered()).toBeNull();
    }
  });

  test('the owner\'s press reaches the passkey with no network call in between: the signer and the ledger were read before the question', async () => {
    const calls: string[] = [];
    const h = harness([registerReq()], {
      rpcWrap: (r) =>
        new Proxy(r, {
          get(target, key) {
            const v = Reflect.get(target, key) as unknown;
            return typeof v === 'function'
              ? (...a: unknown[]) => (calls.push(String(key)), (v as (...x: unknown[]) => unknown).apply(target, a))
              : v;
          },
        }),
    });
    const w = walletSpy(ownerC);
    h.deps.wallet = {
      address: ownerC,
      prepare: async () => void h.events.push('prepare'),
      signEntry: async (x, v) => (h.events.push(`sign after ${calls.length} rpc calls`), w.signEntry(x, v)),
    };
    const baseConfirm = h.deps.confirm;
    let atConfirm = -1;
    h.deps.confirm = async (k, sm) => ((atConfirm = calls.length), baseConfirm(k, sm));
    const out = await processPending(h.deps);
    expect(out.signed).toBe(1);
    expect(h.events.indexOf('prepare')).toBeLessThan(h.events.indexOf('confirm'));
    expect(calls).toContain('getLatestLedger');
    // Nothing touched the rpc between the answer and the passkey.
    expect(h.events).toContain(`sign after ${atConfirm} rpc calls`);
  });

  test('a policy refusal worded "is not allowed" is refused and rejected, never cancelled', async () => {
    // The real check wording: a registry call to a function outside the allowlist.
    const h = harness([registerReq({ entryXdr: b64(authEntry({ signer: ownerC, fn: 'give_feedback', args: [scv.addr(ownerC)] })) })]);
    const out = await processPending(h.deps);
    expect(out.refused).toEqual([{ id: 'r1', reason: 'give_feedback is not allowed', outcome: 'refused' }]);
    expect(h.rejected).toEqual(['r1']);
    expect(h.events).toEqual(['reject']);
  });
});

describe('source scans', () => {
  const srcRoot = join(import.meta.dir, '../src');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const files = walk(srcRoot).filter((f) => /\.tsx?$/.test(f));
  const outside = files.filter((f) => !relative(srcRoot, f).startsWith('mirror/owner-client/'));

  test('signEntry( is referenced only inside src/mirror/owner-client', () => {
    expect(files.some((f) => relative(srcRoot, f).startsWith('mirror/owner-client/') && readFileSync(f, 'utf8').includes('signEntry('))).toBe(true);
    // Any mention: .call, destructuring and ['signEntry'] must not slip past either.
    expect(outside.filter((f) => /\bsignEntry\b/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  test('only processPending calls approveSignRequest', () => {
    const users = outside.filter((f) => /approveSignRequest\s*\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(srcRoot, f));
    expect(users).toEqual(['lib/signing-flow.ts']);
    const flow = readFileSync(join(srcRoot, 'lib/signing-flow.ts'), 'utf8');
    expect(flow.match(/approveSignRequest\s*\(/g)).toHaveLength(1);
  });

  test('the rpc in public-config is not the api host and signing-flow never reads rpc urls from a request', () => {
    expect(PUBLIC.sorobanRpc).toBe(TESTNET.rpcUrl);
    expect(new URL(PUBLIC.sorobanRpc).host).not.toBe(new URL(PUBLIC.apiUrl).host);
    expect(new URL(PUBLIC.sorobanRpc).host).not.toBe(new URL(PUBLIC.appOrigin).host);
    const flow = readFileSync(join(srcRoot, 'lib/signing-flow.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(flow).not.toMatch(/rpcUrl|sorobanRpc|public-config|fetch\(|https?:\/\//i);
    // Trust sources come from the injected deps, never from the request object.
    expect(flow).not.toMatch(/req\.(rpc|uriPrefix|registry|passphrase)/);
  });
});

describe('the confirm wait ends when the request expires', () => {
  const EXP = Date.parse('2026-10-12T12:05:00.000Z');
  const fakeTimer = () => {
    const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
    const after = (ms: number) => {
      let fire!: () => void;
      const done = new Promise<void>((r) => (fire = r));
      const t = { ms, fire, cancelled: false };
      timers.push(t);
      return { done, cancel: () => void (t.cancelled = true) };
    };
    return { timers, after };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('a pending confirm that outlives the request signs nothing, rejects nothing, and reports expired', async () => {
    const h = harness([registerReq()]);
    const t = fakeTimer();
    h.deps.confirm = () => new Promise(() => {});
    const run = processPending({ ...h.deps, expiry: { now: () => EXP - 120_000, after: t.after, marginMs: 15_000 } });
    for (let i = 0; i < 50 && t.timers.length === 0; i++) await tick();
    expect(t.timers[0]!.ms).toBe(105_000);
    t.timers[0]!.fire();
    const out = await run;
    expect(out).toEqual({ signed: 0, refused: [{ id: 'r1', reason: 'expired', outcome: 'expired' }] });
    expect([h.wallet.prompts, h.posted.length, h.rejected.length]).toEqual([0, 0, 0]);
  });

  test('an answer before the expiry still counts, and the timer is cleaned up', async () => {
    const h = harness([registerReq()]);
    const t = fakeTimer();
    const out = await processPending({ ...h.deps, expiry: { now: () => EXP - 120_000, after: t.after, marginMs: 15_000 } });
    expect(out.signed).toBe(1);
    expect(t.timers.every((x) => x.cancelled)).toBe(true);
  });

  test('a request already inside the safety margin is never asked', async () => {
    const h = harness([registerReq()]);
    const out = await processPending({ ...h.deps, expiry: { now: () => EXP - 10_000, after: fakeTimer().after, marginMs: 15_000 } });
    expect(out.refused.map((r) => r.outcome)).toEqual(['expired']);
    expect(h.confirms).toEqual([]);
    expect(h.wallet.prompts).toBe(0);
  });
});

describe('an expiry is told apart from a refusal by the ledger the gate read', () => {
  const at = (sequence: number) => (r: SigningDeps['rpc']) => ({ ...r, getLatestLedger: async () => ({ sequence }) }) as SigningDeps['rpc'];

  test('a request whose ledger window has closed is expired: nothing signed, nothing rejected', async () => {
    const h = harness([registerReq()], { rpcWrap: at(5100) });
    const out = await processPending(h.deps);
    expect(out.refused.map((r) => r.outcome)).toEqual(['expired']);
    expect([h.wallet.prompts, h.posted.length, h.rejected.length]).toEqual([0, 0, 0]);
  });

  test('a refusal after the ledger was read, with time left, stays refused and is rejected (the wallet returned another signature)', async () => {
    const h = harness([registerReq()]);
    const other = walletSpy(ownerC);
    h.deps.wallet = { address: other.address, signEntry: async (_x: string, v: number) => other.signEntry(b64(registerEntry(ownerC, [])), v + 1) };
    const out = await processPending(h.deps);
    expect(out.refused.map((r) => r.outcome)).toEqual(['refused']);
    expect(h.rejected).toEqual(['r1']);
  });
});

