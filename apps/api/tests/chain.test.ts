import { describe, expect, it } from 'bun:test';
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { DEPLOY_LEASE_MS, createChain, type ChainRpc } from '../src/chain/index.js';
import { DEFAULT_ACQUIRE_TIMEOUT_MS } from '../src/chain/lock.js';
import { STALE_CLAIM_MS } from '../src/account/passkey.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { contractAddress } from './support/fixtures.js';
import { simError, simSuccess } from './support/soroban.js';
import { walletDeployTx } from './support/sponsor-txs.js';

const sponsorKp = Keypair.random();
const env = { SPONSOR_SECRET: sponsorKp.secret() };
const sponsor = sponsorKp.publicKey();
const ownerC = contractAddress(7);
const base = { rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env };

function fakeRpc() {
  const state = { seq: 10n, sent: [] as Transaction[], failSim: false, sendStatus: 'PENDING' as string, pollStatus: 'SUCCESS' as string };
  const rpcFake: ChainRpc = {
    getAccount: async (id) => new Account(id, state.seq.toString()),
    simulateTransaction: async () => (state.failSim ? simError('HostError: Error(Auth, InvalidAction)') : simSuccess()),
    sendTransaction: async (tx) => {
      if (state.sendStatus === 'PENDING') {
        state.sent.push(tx as Transaction);
        state.seq++;
      }
      return { status: state.sendStatus, hash: (tx as Transaction).hash().toString('hex'), latestLedger: 5001, latestLedgerCloseTime: '1759572000' } as unknown as rpc.Api.SendTransactionResponse;
    },
    getLatestLedger: async () => ({ sequence: 5000 }),
    pollTransaction: async () =>
      ({ status: state.pollStatus, returnValue: nativeToScVal(42, { type: 'u32' }) }) as unknown as rpc.Api.GetTransactionResponse,
  };
  return { state, rpc: rpcFake };
}

// The owner's entry, as simulation returns it: address credentials (the owner signs it; the sponsor never does).
const anyAuth = () => [
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(ownerC).toScAddress(), nonce: new xdr.Int64(1), signatureExpirationLedger: 5000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TESTNET.registry).toScAddress(), functionName: 'register_with_uri', args: [] }),
      ),
      subInvocations: [],
    }),
  }),
];

const call = (source: Account, auth?: xdr.SorobanAuthorizationEntry[]) =>
  new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: TESTNET.registry,
        function: 'register_with_uri',
        args: [Address.fromString(ownerC).toScVal(), nativeToScVal('https://public.example.test/a/x/agent.json', { type: 'string' })],
        ...(auth ? { auth } : {}),
      }),
    )
    .setTimeout(300)
    .build();

/** True if `p` is still pending after a short wait (used only for "stays blocked" checks). */
const stillBlocked = (p: Promise<unknown>) => Promise.race([p.then(() => false), Bun.sleep(25).then(() => true)]);
const T = 5_000;
/** Replaces the global timers with a clock that moves only on `advance`, so lease timing is exact. */
function manualClock() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let ids = 0;
  (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0) => {
    const id = ++ids;
    pending.push({ at: now + ms, fn, id });
    return id;
  };
  (globalThis as { clearTimeout: unknown }).clearTimeout = (id: number) => {
    const i = pending.findIndex((p) => p.id === id);
    if (i >= 0) pending.splice(i, 1);
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    async advance(ms: number) {
      const to = now + ms;
      for (;;) {
        pending.sort((x, y) => x.at - y.at);
        const next = pending[0];
        if (!next || next.at > to) break;
        pending.shift();
        now = next.at;
        next.fn();
        await flush();
      }
      now = to;
      await flush();
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

const WRONG = Keypair.random().publicKey();
const callTx = (seq: string, auth = anyAuth()) => call(new Account(sponsor, String(BigInt(seq) - 1n)), auth);

describe('chain', () => {
  it('refuses a missing or invalid SPONSOR_SECRET', () => {
    expect(() => createChain({ ...base, env: {} })).toThrow('chain: SPONSOR_SECRET is not set');
    expect(() => createChain({ ...base, env: { SPONSOR_SECRET: 'nope' } })).toThrow('chain: SPONSOR_SECRET is not a valid Stellar secret');
  });

  it('the sponsor signs testnet txs it sources; refuses other networks and other sources', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc });
    expect(c.sponsorPublicKey).toBe(sponsor);
    const tx = call(new Account(sponsor, '10'));
    const signed = TransactionBuilder.fromXDR(await c.sponsor.signTransaction(tx.toXDR(), TESTNET.passphrase), TESTNET.passphrase) as Transaction;
    expect(sponsorKp.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
    await expect(c.sponsor.signTransaction(tx.toXDR(), Networks.PUBLIC)).rejects.toThrow('chain: the sponsor signs testnet transactions only');
    const foreign = call(new Account(Keypair.random().publicKey(), '1'));
    await expect(c.sponsor.signTransaction(foreign.toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: the sponsor signs only transactions it sources');
  });

  it('seam calls are plain RPC calls: concurrent sponsor reads never wait on each other', async () => {
    // Serialising the sponsor is the caller's `sponsorLock` (= withSponsorLock), not the seam.
    const c = createChain({ ...base, rpc: fakeRpc().rpc });
    const [a, b] = await Promise.all([c.soroban.getAccount(sponsor), c.soroban.getAccount(sponsor)]);
    expect(call(a, anyAuth()).sequence).toBe(call(b, anyAuth()).sequence);
    const { auth } = await c.soroban.prepare!(call(a)); // no auth on the op: recording
    expect(auth).toEqual([]);
    const { prepared } = await c.soroban.prepare!(call(a, anyAuth()));
    expect(Number(prepared.fee)).toBeGreaterThanOrEqual(250_000);
    expect((await c.soroban.send(prepared)).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failed simulation throws', async () => {
    const f = fakeRpc();
    f.state.failSim = true;
    const c = createChain({ ...base, rpc: f.rpc });
    const a = await c.soroban.getAccount(sponsor);
    await expect(c.soroban.prepare!(call(a, anyAuth()))).rejects.toThrow('chain: simulation failed: HostError: Error(Auth, InvalidAction)');
  });

  it('send treats ERROR and TRY_AGAIN_LATER as failures', async () => {
    for (const status of ['ERROR', 'TRY_AGAIN_LATER']) {
      const f = fakeRpc();
      f.state.sendStatus = status;
      const c = createChain({ ...base, rpc: f.rpc });
      const a = await c.soroban.getAccount(sponsor);
      const { prepared } = await c.soroban.prepare!(call(a, anyAuth()));
      await expect(c.soroban.send(prepared)).rejects.toThrow(`chain: sendTransaction returned ${status}`);
    }
  });

  it('horizonSubmit returns the hash, and throws with the Horizon result codes on an error', async () => {
    let status = 200;
    const fakeFetch = (async () =>
      status === 200
        ? new Response(JSON.stringify({ hash: 'a'.repeat(64), ledger: 5001, successful: true, envelope_xdr: 'AAAA', result_xdr: 'AAAA' }), { status })
        : new Response(
            JSON.stringify({
              type: 'https://stellar.org/horizon-errors/transaction_failed',
              title: 'Transaction Failed',
              status: 400,
              extras: { result_codes: { transaction: 'tx_bad_seq' } },
            }),
            { status },
          )) as unknown as typeof fetch;
    const c = createChain({ ...base, rpc: fakeRpc().rpc, fetch: fakeFetch });
    const a = await c.soroban.getAccount(sponsor); // seq 10 -> the tx carries 11
    expect(await c.horizonSubmit(call(a, anyAuth()).toXDR())).toEqual({ hash: 'a'.repeat(64) });
    const b = await c.soroban.getAccount(sponsor);
    status = 400;
    await expect(c.horizonSubmit(call(b, anyAuth()).toXDR())).rejects.toThrow(/Horizon submit failed: 400 Transaction Failed .*tx_bad_seq/);
  });

  it('withSponsorLock runs one section at a time, in order', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc });
    const log: string[] = [];
    let finish!: () => void;
    const first = c.withSponsorLock(async () => {
      log.push('a:start');
      await new Promise<void>((r) => (finish = r));
      log.push('a:end');
    });
    const second = c.withSponsorLock(async () => void log.push('b:start'));
    expect(await stillBlocked(second)).toBe(true);
    expect(log).toEqual(['a:start']);
    finish();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('withSponsorLock releases when its section throws, and rethrows', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc });
    await expect(c.withSponsorLock(async () => { throw new Error('send failed'); })).rejects.toThrow('send failed');
    expect(await stillBlocked(c.withSponsorLock(async () => 'next'))).toBe(false);
  });

  it('the lease frees a section that never settles', async () => {
    const clock = manualClock();
    try {
      const c = createChain({ ...base, rpc: fakeRpc().rpc, leaseMs: 40 });
      void c.withSponsorLock(() => new Promise<void>(() => {}));
      let ran = false;
      const next = c.withSponsorLock(async () => void (ran = true));
      await Bun.sleep(1); // let both acquires register their timers (real sleep, not the manual clock)
      await clock.advance(39);
      expect(ran).toBe(false);
      await clock.advance(1);
      await next;
      expect(ran).toBe(true);
    } finally {
      clock.restore();
    }
  }, T);

  it('confirm returns the executed return value on SUCCESS and throws otherwise; latestLedger reads RPC', async () => {
    const f = fakeRpc();
    const c = createChain({ ...base, rpc: f.rpc });
    expect((await c.soroban.confirm!('b'.repeat(64)))?.u32()).toBe(42);
    expect(await c.soroban.latestLedger!()).toBe(5000);
    f.state.pollStatus = 'FAILED';
    await expect(c.soroban.confirm!('b'.repeat(64))).rejects.toThrow(`chain: transaction ${'b'.repeat(64)} did not succeed: FAILED`);
  });
});

describe('chain: the sponsor signs only what the library builds', () => {
  const chain = () => createChain({ ...base, rpc: fakeRpc().rpc });
  const sign = (tx: { toXDR(): string }) => chain().sponsor.signTransaction(tx.toXDR(), TESTNET.passphrase);
  const MSG = 'chain: the sponsor refuses this transaction';
  const acct = () => new Account(sponsor, '10');
  const agent = Keypair.random().publicKey();
  const [usdcCode, usdcIssuer] = TESTNET.usdc.split(':') as [string, string];
  const usdc = new Asset(usdcCode, usdcIssuer);

  it('accepts the sponsored-account shape and the registry calls', async () => {
    const sponsored = new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent }))
      .addOperation(Operation.createAccount({ destination: agent, startingBalance: '0' }))
      .addOperation(Operation.changeTrust({ asset: usdc, source: agent }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: agent }))
      .setTimeout(120)
      .build();
    await sign(sponsored);
    await sign(call(acct(), anyAuth()));
    const bind = new TransactionBuilder(acct(), { fee: '400000', networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: TESTNET.registry, function: 'set_agent_wallet', args: [] }))
      .setTimeout(300)
      .build();
    await sign(bind);
  });

  it('pins the trustline to the classic testnet USDC the library uses', async () => {
    // NETWORKS is not a public export of the library: read the vendored build by path.
    const { NETWORKS } = (await import(new URL('../node_modules/agentenact/dist/networks.js', import.meta.url).href)) as {
      NETWORKS: Record<string, { assets: Record<string, { asset: string }> }>;
    };
    expect(NETWORKS['stellar:testnet']!.assets[TESTNET.usdcSac]!.asset).toBe(TESTNET.usdc);
  });

  it('refuses a sponsored trustline to any other asset', async () => {
    const withAsset = (asset: Asset) =>
      new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
        .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent }))
        .addOperation(Operation.createAccount({ destination: agent, startingBalance: '0' }))
        .addOperation(Operation.changeTrust({ asset, source: agent }))
        .addOperation(Operation.endSponsoringFutureReserves({ source: agent }))
        .setTimeout(120)
        .build();
    await expect(sign(withAsset(new Asset('USDC', Keypair.random().publicKey())))).rejects.toThrow(MSG); // look-alike issuer
    await expect(sign(withAsset(new Asset('USDX', usdcIssuer)))).rejects.toThrow(MSG); // same issuer, other code
    await sign(withAsset(usdc));
  });

  it('refuses a payment operation', async () => {
    const pay = new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: agent, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    await expect(sign(pay)).rejects.toThrow(MSG);
  });

  it('refuses a mixed tx with one forbidden op', async () => {
    const mixed = new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.createAccount({ destination: agent, startingBalance: '0' }))
      .addOperation(Operation.payment({ destination: agent, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    await expect(sign(mixed)).rejects.toThrow(MSG);
  });

  it('refuses a fee bump', async () => {
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsorKp, '1000000', call(acct(), anyAuth()), TESTNET.passphrase);
    await expect(sign(bump)).rejects.toThrow(MSG);
  });

  it('refuses another contract or another function', async () => {
    for (const [contract, fn] of [
      [TESTNET.usdcSac, 'register_with_uri'],
      [TESTNET.registry, 'transfer'],
    ] as const) {
      const tx = new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
        .addOperation(Operation.invokeContractFunction({ contract, function: fn, args: [] }))
        .setTimeout(60)
        .build();
      await expect(sign(tx)).rejects.toThrow(MSG);
    }
  });

  it('refuses a fee above the cap with a distinct error; the cap is configurable', async () => {
    const withFee = (fee: string) =>
      new TransactionBuilder(acct(), { fee, networkPassphrase: TESTNET.passphrase })
        .addOperation(Operation.invokeContractFunction({ contract: TESTNET.registry, function: 'register_with_uri', args: [] }))
        .setTimeout(60)
        .build();
    await expect(sign(withFee('1000000001'))).rejects.toThrow('chain: fee 1000000001 above cap 1000000000');
    await sign(withFee('1000000000')); // the default cap: 100 XLM
    const tight = createChain({ ...base, rpc: fakeRpc().rpc, maxFeeStroops: 5_000_000n });
    await expect(tight.sponsor.signTransaction(withFee('5000001').toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: fee 5000001 above cap 5000000');
    await tight.sponsor.signTransaction(withFee('5000000').toXDR(), TESTNET.passphrase);
  });

  it('pins the sponsored-account shape: no drain, no foreign sponsorship, no sponsor-sourced agent ops', async () => {
    const other = Keypair.random().publicKey();
    const build = (ops: xdr.Operation[]) => {
      const b = new TransactionBuilder(acct(), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase });
      for (const o of ops) b.addOperation(o);
      return b.setTimeout(60).build();
    };
    const begin = (id: string) => Operation.beginSponsoringFutureReserves({ sponsoredId: id });
    const create = (balance: string) => Operation.createAccount({ destination: agent, startingBalance: balance });
    const trust = (source: string) => Operation.changeTrust({ asset: usdc, source });
    const end = (source: string) => Operation.endSponsoringFutureReserves({ source });
    await expect(sign(build([begin(agent), create('1'), trust(agent), end(agent)]))).rejects.toThrow(MSG);
    await expect(sign(build([begin(other), create('0'), trust(agent), end(agent)]))).rejects.toThrow(MSG);
    await expect(sign(build([begin(agent), create('0'), trust(sponsor), end(agent)]))).rejects.toThrow(MSG);
    await expect(sign(build([begin(agent), create('0'), trust(agent), end(sponsor)]))).rejects.toThrow(MSG);
    await expect(sign(build([Operation.beginSponsoringFutureReserves({ sponsoredId: agent, source: other }), create('0'), trust(agent), end(agent)]))).rejects.toThrow(MSG);
    const withSource = build([
      Operation.invokeContractFunction({ contract: TESTNET.registry, function: 'register_with_uri', args: [], source: other } as never),
    ]);
    await expect(sign(withSource)).rejects.toThrow(MSG);
    await expect(sign(build([begin(agent), Operation.createAccount({ destination: agent, startingBalance: '0', source: other }), trust(agent), end(agent)]))).rejects.toThrow(MSG);
    const createOther = Operation.createAccount({ destination: other, startingBalance: '0' });
    await expect(sign(build([begin(agent), create('0'), createOther, trust(agent), end(agent)]))).rejects.toThrow(MSG);
    await expect(sign(build([trust(agent), end(agent)]))).rejects.toThrow(MSG);
    await expect(sign(build([begin(agent), create('0'), trust(other), end(other)]))).rejects.toThrow(MSG);
    await expect(sign(build([begin(agent), create('0'), trust(agent), trust(agent), end(agent)]))).rejects.toThrow(MSG);
    const registryCall = Operation.invokeContractFunction({ contract: TESTNET.registry, function: 'register_with_uri', args: [] });
    await expect(sign(build([begin(agent), create('0'), trust(agent), end(agent), registryCall]))).rejects.toThrow(MSG);
    await expect(sign(build([registryCall, registryCall]))).rejects.toThrow(MSG);
    await sign(build([begin(agent), create('0'), trust(agent), end(agent)])); // the library's real tx 1
    await sign(build([registryCall])); // the library's register / bind txs
  });
});

describe('chain: error mapping', () => {
  it('horizonSubmit keeps the status of a non-JSON error body', async () => {
    const fakeFetch = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const c = createChain({ ...base, rpc: fakeRpc().rpc, fetch: fakeFetch });
    const a = await c.soroban.getAccount(sponsor);
    await expect(c.horizonSubmit(call(a, anyAuth()).toXDR())).rejects.toThrow(/Horizon submit failed: 502/);
  });

  it('send includes the public errorResult', async () => {
    const f = fakeRpc();
    f.state.sendStatus = 'ERROR';
    const orig = f.rpc.sendTransaction;
    f.rpc.sendTransaction = async (tx) => ({ ...(await orig(tx)), errorResult: 'AAAAAAAAAGT/////' }) as unknown as rpc.Api.SendTransactionResponse;
    const c = createChain({ ...base, rpc: f.rpc });
    const a = await c.soroban.getAccount(sponsor);
    await expect(c.soroban.send(call(a, anyAuth()))).rejects.toThrow(/sendTransaction returned ERROR.*AAAAAAAAAGT/);
  });
});

describe('chain: a sponsor refusal', () => {
  it('a fee-cap refusal throws and signs nothing', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc, maxFeeStroops: 5_000_000n });
    const a = await c.soroban.getAccount(sponsor);
    const tooDear = new TransactionBuilder(a, { fee: '5000001', networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: TESTNET.registry, function: 'register_with_uri', args: [] }))
      .setTimeout(60)
      .build();
    await expect(c.sponsor.signTransaction(tooDear.toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: fee 5000001 above cap 5000000');
  });

  it('a shape refusal and a foreign-source refusal throw', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc });
    const a = await c.soroban.getAccount(sponsor);
    const foreign = new TransactionBuilder(new Account(WRONG, '10'), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: sponsor, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    await expect(c.sponsor.signTransaction(foreign.toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: the sponsor signs only transactions it sources');
    const pay = new TransactionBuilder(a, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: WRONG, asset: Asset.native(), amount: '1' }))
      .setTimeout(60)
      .build();
    await expect(c.sponsor.signTransaction(pay.toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: the sponsor refuses this transaction');
  });
});

describe('chain: the lock wait is capped (M6)', () => {
  it('a section that waits past acquireTimeoutMs fails with chain_busy; the queue stays consistent', async () => {
    const c = createChain({ ...base, rpc: fakeRpc().rpc, acquireTimeoutMs: 20 });
    let finish!: () => void;
    const holder = c.withSponsorLock(() => new Promise<void>((r) => (finish = r)));
    await expect(c.withSponsorLock(async () => 'late')).rejects.toMatchObject({ message: 'chain: chain_busy', code: 'chain_busy' });
    const next = c.withSponsorLock(async () => 'queued'); // behind the timed-out waiter
    finish();
    await holder;
    expect(await next).toBe('queued');
  });

  it('defaults keep wait + the wallet-deploy lease under the passkey stale-claim window', () => {
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS + DEPLOY_LEASE_MS).toBeLessThan(STALE_CLAIM_MS / 2);
  });
});

describe('chain: registry and account reads (provision recovery)', () => {
  /**
   * Shaped like the testnet registry (probed 2026-10-04, read-only): find_owner / get_agent_wallet of an
   * unknown id return None (scvVoid); agent_uri of an unknown id fails with Error(Contract, #2) (AgentNotFound).
   */
  const viewRpc = (o: { owner?: string; wallet?: string; down?: boolean; ownerError?: string; walletError?: string; ownerLedger?: number; walletLedger?: number }) => {
    const f = fakeRpc();
    const seen: string[] = [];
    f.rpc.simulateTransaction = async (tx) => {
      if (o.down) throw new Error('fetch failed');
      const ic = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
      seen.push(`${Address.fromScAddress(ic.contractAddress()).toString() === TESTNET.registry ? 'registry' : 'other'}.${ic.functionName().toString()}(${ic.args()[0]!.u32()})`);
      if (ic.functionName().toString() === 'find_owner') {
        if (o.ownerError) return simError(o.ownerError);
        return { ...simSuccess([], o.owner ? Address.fromString(o.owner).toScVal() : xdr.ScVal.scvVoid()), latestLedger: o.ownerLedger ?? 5000 } as rpc.Api.SimulateTransactionResponse;
      }
      if (o.walletError) return simError(o.walletError);
      return { ...simSuccess([], o.wallet ? Address.fromString(o.wallet).toScVal() : xdr.ScVal.scvVoid()), latestLedger: o.walletLedger ?? 5000 } as rpc.Api.SimulateTransactionResponse;
    };
    return { f, seen };
  };

  it('identity reads owner and wallet from the registry without taking the sponsor lock', async () => {
    const agentG = Keypair.random().publicKey();
    const { f, seen } = viewRpc({ owner: ownerC, wallet: agentG });
    const c = createChain({ ...base, rpc: f.rpc });
    await c.soroban.getAccount(sponsor); // lock held
    expect(await c.identity('42')).toEqual({ owner: ownerC, wallet: agentG, ledger: 5000 });
    expect(seen).toEqual(['registry.find_owner(42)', 'registry.get_agent_wallet(42)']);
  });

  it('identity: unbound → wallet null; unknown id → null; RPC down → throws; junk id → throws', async () => {
    expect(await createChain({ ...base, rpc: viewRpc({ owner: ownerC }).f.rpc }).identity('7')).toEqual({ owner: ownerC, wallet: null, ledger: 5000 });
    expect(await createChain({ ...base, rpc: viewRpc({}).f.rpc }).identity('7')).toBeNull(); // find_owner → None
    await expect(createChain({ ...base, rpc: viewRpc({ down: true }).f.rpc }).identity('7')).rejects.toThrow('chain: registry read failed');
    await expect(createChain({ ...base, rpc: viewRpc({}).f.rpc }).identity('4294967296')).rejects.toThrow('chain: bad agent id');
  });

  it('identity reports the ledger its answer is as fresh as: the LOWER of its two simulations', async () => {
    const chainWith = (o: Parameters<typeof viewRpc>[0]) => createChain({ ...base, rpc: viewRpc(o).f.rpc });
    expect((await chainWith({ owner: ownerC, ownerLedger: 5205, walletLedger: 5203 }).identity('7'))!.ledger).toBe(5203);
    expect((await chainWith({ owner: ownerC, ownerLedger: 5201, walletLedger: 5209 }).identity('7'))!.ledger).toBe(5201);
  });

  it('identity: only the registry\'s AgentNotFound (Error(Contract, #2)) means "no such agent"; any other simulation error throws', async () => {
    const chainWith = (o: Parameters<typeof viewRpc>[0]) => createChain({ ...base, rpc: viewRpc(o).f.rpc });
    expect(await chainWith({ ownerError: 'HostError: Error(Contract, #2)\n\nEvent log (newest first): ...' }).identity('7')).toBeNull();
    for (const other of ['HostError: Error(Contract, #4)', 'HostError: Error(Budget, ExceededLimit)', 'HostError: Error(Storage, MissingValue)', 'HostError: Error(Contract, #21)']) {
      await expect(chainWith({ ownerError: other }).identity('7')).rejects.toThrow('chain: registry read failed');
    }
    await expect(chainWith({ owner: ownerC, walletError: 'HostError: Error(Contract, #2)' }).identity('7')).rejects.toThrow('chain: registry read failed');
  });

  it('accountExists asks Horizon: 200 → true, 404 → false, anything else throws', async () => {
    const g = Keypair.random().publicKey();
    const urls: string[] = [];
    const fetchWith = (status: number) =>
      (async (url: string) => (urls.push(url), new Response(status === 200 ? JSON.stringify({ id: g }) : '{}', { status }))) as unknown as typeof fetch;
    expect(await createChain({ ...base, rpc: fakeRpc().rpc, fetch: fetchWith(200) }).accountExists(g)).toBe(true);
    expect(await createChain({ ...base, rpc: fakeRpc().rpc, fetch: fetchWith(404) }).accountExists(g)).toBe(false);
    await expect(createChain({ ...base, rpc: fakeRpc().rpc, fetch: fetchWith(503) }).accountExists(g)).rejects.toThrow('chain: Horizon account read failed: 503');
    await expect(createChain({ ...base, rpc: fakeRpc().rpc, fetch: fetchWith(200) }).accountExists('nope')).rejects.toThrow('chain: bad account id');
    expect(urls).toEqual([`${TESTNET.horizonUrl}/accounts/${g}`, `${TESTNET.horizonUrl}/accounts/${g}`, `${TESTNET.horizonUrl}/accounts/${g}`]);
  });
});

describe('chain: the sponsor signs the passkey wallet deploy, and only its own authorization', () => {
  const chain = () => createChain({ ...base, rpc: fakeRpc().rpc });
  const sign = (tx: { toXDR(): string }) => chain().sponsor.signTransaction(tx.toXDR(), TESTNET.passphrase);
  const MSG = 'chain: the sponsor refuses this transaction';

  it('accepts our account wasm deployed by the sponsor, with or without its own matching auth entry', async () => {
    await sign(walletDeployTx(sponsor));
    await sign(walletDeployTx(sponsor, { ownAuth: 'same' }));
  });

  it('refuses another wasm, another deployer, and any own auth entry that is not exactly the deploy', async () => {
    await expect(sign(walletDeployTx(sponsor, { wasmHash: 'ab'.repeat(32) }))).rejects.toThrow(MSG);
    await expect(sign(walletDeployTx(sponsor, { deployer: WRONG }))).rejects.toThrow(MSG);
    await expect(sign(walletDeployTx(sponsor, { ownAuth: 'nested' }))).rejects.toThrow(MSG);
    await expect(sign(walletDeployTx(sponsor, { ownAuth: 'other' }))).rejects.toThrow(MSG);
  });

  it('a registry call may carry the sponsor\'s own entry only for that very call, with nothing under it', async () => {
    const own = (fn: string, sub: xdr.SorobanAuthorizedInvocation[] = [], args?: xdr.ScVal[]) => {
      const tx = call(new Account(sponsor, '10'));
      const ic = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
      return call(new Account(sponsor, '10'), [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({ contractAddress: ic.contractAddress(), functionName: fn, args: args ?? ic.args() }),
            ),
            subInvocations: sub,
          }),
        }),
      ]);
    };
    await sign(own('register_with_uri'));
    await expect(sign(own('register_with_uri', [], []))).rejects.toThrow(MSG);
    await expect(sign(own('set_agent_wallet'))).rejects.toThrow(MSG);
    const transfer = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TESTNET.usdcSac).toScAddress(), functionName: 'transfer', args: [] }),
      ),
      subInvocations: [],
    });
    await expect(sign(own('register_with_uri', [transfer]))).rejects.toThrow(MSG);
  });
});

describe('chain: the sponsor key in the vault', () => {
  const remoteEnv = { SPONSOR_PUBLIC_KEY: sponsor };

  it('with SPONSOR_PUBLIC_KEY, signs through the remote signer after the same policy, and reads no secret', async () => {
    const asked: string[] = [];
    const c = createChain({
      rpId: 'agentenact.io',
      origin: 'https://app.agentenact.io',
      env: remoteEnv,
      rpc: fakeRpc().rpc,
      remoteSponsor: (publicKey) => ({
        publicKey,
        async signTransaction(x) {
          asked.push(x);
          return 'signed';
        },
      }),
    });
    expect([c.sponsorPublicKey, c.sponsorIsRemote]).toEqual([sponsor, true]);
    expect(await c.sponsor.signTransaction(callTx('11').toXDR(), TESTNET.passphrase)).toBe('signed');
    const pay = new TransactionBuilder(new Account(sponsor, '10'), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: WRONG, asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    await expect(c.sponsor.signTransaction(pay.toXDR(), TESTNET.passphrase)).rejects.toThrow('chain: the sponsor refuses this transaction');
    expect(asked).toHaveLength(1);
  });

  it('a SPONSOR_PUBLIC_KEY that is no G-address, or without a remote signer, fails at construction', () => {
    const remoteSponsor = (publicKey: string) => ({ publicKey, signTransaction: async () => 'x' });
    expect(() => createChain({ ...base, env: { SPONSOR_PUBLIC_KEY: 'GBAD' }, remoteSponsor })).toThrow(/SPONSOR_PUBLIC_KEY must be/);
    expect(() => createChain({ ...base, env: remoteEnv })).toThrow(/SPONSOR_PUBLIC_KEY must be/);
    expect(createChain({ ...base, rpc: fakeRpc().rpc }).sponsorIsRemote).toBe(false);
  });
});
