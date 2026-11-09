import { describe, expect, it } from 'bun:test';
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, TransactionBuilder, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';
import { MAX_SIGNATURE_LEDGERS, approveSignRequest, type Approval, type OwnerWallet } from '../src/owner-client/approve.js';
import { isCancelled, isRetryable } from '../src/owner-client/errors.js';
import { simulateEntry } from '../src/owner-client/simulate.js';
import { findPasskeySigner } from '../src/owner-client/wallet.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import type { PublicSignRequest } from '../src/owner-client/types.js';
import { authEntry, b64, scv, signEntry } from './support/entries.js';
import { contractAddress } from './support/fixtures.js';
import { simError, simSuccess } from './support/soroban.js';

const ownerC = contractAddress(7);
const sponsor = Keypair.random().publicKey();
const agentG = Keypair.random().publicKey();
const prefix = 'https://public.example.test/a/';
const uri = `${prefix}0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e/agent.json`;
const LATEST = 5000;
const yes = async () => true;

const registerArgs = [scv.addr(ownerC), scv.str(uri)];
const registerEntry = () => authEntry({ signer: ownerC, fn: 'register_with_uri', args: registerArgs });

const req = (over: Partial<PublicSignRequest> = {}): PublicSignRequest => ({
  id: 'r1',
  kind: 'register',
  agentId: 'a1',
  entryXdr: b64(registerEntry()),
  validUntilLedger: 5100,
  networkPassphrase: TESTNET.passphrase,
  expiresAt: '2026-10-04T12:05:00.000Z',
  source: sponsor,
  agentWallet: agentG,
  registerTx: null,
  ...over,
});

/** RPC whose recording simulation asks the owner for the very call (fresh nonce, as on testnet). */
function rpcAsking(entries = () => [authEntry({ signer: ownerC, nonce: 999_001, fn: 'register_with_uri', args: registerArgs })]) {
  const seen: Transaction[] = [];
  return {
    seen,
    rpc: {
      simulateTransaction: async (tx: Transaction) => (seen.push(tx), simSuccess(entries())),
      getLatestLedger: async () => ({ sequence: LATEST }),
      getTransaction: async (): Promise<rpc.Api.GetTransactionResponse> => {
        throw new Error('no transaction reads expected');
      },
    },
  };
}

function walletSpy(): OwnerWallet & { calls: number; expiries: number[] } {
  const w = {
    address: ownerC,
    calls: 0,
    expiries: [] as number[],
    async signEntry(entryXdr: string, validUntil: number) {
      w.calls++;
      w.expiries.push(validUntil);
      return b64(signEntry(xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64'), validUntil));
    },
  };
  return w;
}

const expiryOf = (signedXdr: string) =>
  xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, 'base64').credentials().address().signatureExpirationLedger();

describe('simulateEntry', () => {
  it('builds the same registry call, unsigned, from the sponsor, and finds the owner entry', async () => {
    const r = rpcAsking();
    expect(await simulateEntry(b64(registerEntry()), { rpc: r.rpc, source: sponsor, passphrase: TESTNET.passphrase })).toEqual({ ok: true });
    const tx = r.seen[0]!;
    expect(tx.source).toBe(sponsor);
    const op = tx.operations[0] as unknown as { auth?: unknown[] };
    expect(op.auth ?? []).toEqual([]);
  });

  it('refuses when the network does not ask the owner for this exact authorisation', async () => {
    const other = rpcAsking(() => [authEntry({ signer: contractAddress(9), fn: 'register_with_uri', args: registerArgs })]);
    expect(await simulateEntry(b64(registerEntry()), { rpc: other.rpc, source: sponsor, passphrase: TESTNET.passphrase })).toEqual({
      ok: false,
      reason: 'the call does not ask your wallet for this authorisation',
    });
  });

  it('refuses when the network rejects the call', async () => {
    const failing = { simulateTransaction: async () => simError('HostError: Error(Contract, #3)') };
    expect(await simulateEntry(b64(registerEntry()), { rpc: failing, source: sponsor, passphrase: TESTNET.passphrase })).toEqual({
      ok: false,
      reason: 'the network rejects this call: HostError: Error(Contract, #3)',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// A testnet-shaped chain for the bind: the register tx (fee-bumped, as the platform submits it)
// carries the owner's signed entry and returned agentId 42; registry views answer per agent.
// ---------------------------------------------------------------------------------------------

const REGISTER_TX = 'b'.repeat(64);
const bindArgs = (id: number, wallet: string) => [scv.addr(ownerC), scv.u32(id), scv.addr(wallet)];
const bindEntry = (id = 42, wallet = agentG) => authEntry({ signer: ownerC, fn: 'set_agent_wallet', args: bindArgs(id, wallet) });
const bindReq = (over: Partial<PublicSignRequest> = {}) => req({ kind: 'bind', entryXdr: b64(bindEntry()), ...over });

interface ChainState {
  /** Auth entries the register op carried (default: exactly the one the owner signed). */
  registerAuth?: (signed: xdr.SorobanAuthorizationEntry) => xdr.SorobanAuthorizationEntry[];
  registerFn?: string;
  registerUri?: string;
  registerContract?: string;
  registerOwner?: string;
  extraOp?: boolean;
  status?: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  returnValue?: xdr.ScVal | undefined;
  agents?: Record<number, { owner: string; wallet: string | null; uri: string }>;
}

function chain(approval: Approval, s: ChainState = {}) {
  const seen: Transaction[] = [];
  const txReads: string[] = [];
  // Realistic default: stellar-8004 sets a new agent's wallet to its owner at registration (testnet, agents 37/38).
  const agents = s.agents ?? { 42: { owner: ownerC, wallet: ownerC, uri } };
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(approval.signedEntryXdr, 'base64');
  const registerOp = Operation.invokeContractFunction({
    contract: s.registerContract ?? TESTNET.registry,
    function: s.registerFn ?? 'register_with_uri',
    args: [scv.addr(s.registerOwner ?? ownerC), scv.str(s.registerUri ?? uri)],
    auth: s.registerAuth ? s.registerAuth(signed) : [signed],
  });
  const builder = new TransactionBuilder(new Account(sponsor, '41'), { fee: '100', networkPassphrase: TESTNET.passphrase }).addOperation(registerOp);
  if (s.extraOp) builder.addOperation(registerOp);
  const built = builder.setTimeout(300).build();
  // Assembled as the platform submits it: Soroban data with a realistic resource fee, then fee-bumped.
  const inner = TransactionBuilder.cloneFrom(built, { fee: built.fee, sorobanData: new SorobanDataBuilder().setResourceFee(250_000).build() }).build();
  const feeBumped = TransactionBuilder.buildFeeBumpTransaction(sponsor, '2650000', inner, TESTNET.passphrase);
  const status = s.status ?? 'SUCCESS';
  const txResponse = (
    status === 'NOT_FOUND'
      ? { status, latestLedger: LATEST, latestLedgerCloseTime: 0, oldestLedger: 1, oldestLedgerCloseTime: 0, txHash: REGISTER_TX }
      : {
          status,
          txHash: REGISTER_TX,
          latestLedger: LATEST,
          ledger: LATEST - 3,
          createdAt: 1_759_000_000,
          applicationOrder: 1,
          feeBump: true,
          envelopeXdr: feeBumped.toEnvelope(),
          ...('returnValue' in s ? (s.returnValue ? { returnValue: s.returnValue } : {}) : { returnValue: scv.u32(42) }),
        }
  ) as unknown as rpc.Api.GetTransactionResponse;

  const view = (fn: string, id: number): rpc.Api.SimulateTransactionResponse => {
    const a = agents[id];
    if (!a) return simError('HostError: Error(Contract, #2)');
    if (fn === 'find_owner') return simSuccess([], scv.addr(a.owner));
    if (fn === 'get_agent_wallet') return simSuccess([], a.wallet ? scv.addr(a.wallet) : xdr.ScVal.scvVoid());
    if (fn === 'agent_uri') return simSuccess([], scv.str(a.uri));
    return simError(`no such view ${fn}`);
  };

  return {
    seen,
    txReads,
    rpc: {
      async simulateTransaction(tx: Transaction) {
        seen.push(tx);
        const call = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
        const fn = call.functionName().toString();
        const args = call.args();
        if (fn === 'set_agent_wallet') {
          const wallet = Address.fromScVal(args[2]!).toString();
          return simSuccess([
            authEntry({ signer: ownerC, nonce: 999_002, fn, args }),
            authEntry({ signer: wallet, nonce: 999_003, fn, args }),
          ]);
        }
        return view(fn, args[0]!.u32());
      },
      getLatestLedger: async () => ({ sequence: LATEST }),
      getTransaction: async (hash: string) => {
        txReads.push(hash);
        return txResponse;
      },
    },
  };
}

/** The owner's real register approval, as the UI keeps it between the two approvals. */
async function approvedRegistration(): Promise<Approval> {
  return approveSignRequest(req(), walletSpy(), { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes });
}

describe('approveSignRequest', () => {
  it('check → simulate → confirm → sign; returns the plain summary', async () => {
    const w = walletSpy();
    const shown: string[] = [];
    const out = await approveSignRequest(req(), w, {
      rpc: rpcAsking().rpc,
      uriPrefix: prefix,
      confirm: async (s) => (shown.push(s), true),
    });
    expect(w.calls).toBe(1);
    expect(out.summary).toBe(`Create a new agent identity owned by your wallet, described at ${uri}.`);
    expect(shown).toEqual([out.summary]);
    expect(out.call).toEqual({ fn: 'register_with_uri', owner: ownerC, agentUri: uri });
  });

  it('a crafted SAC transfer is refused without any passkey prompt or simulation', async () => {
    const w = walletSpy();
    const r = rpcAsking();
    const transfer = authEntry({ signer: ownerC, contract: TESTNET.usdcSac, fn: 'transfer', args: [scv.addr(ownerC), scv.addr(agentG), scv.i128(10_000_000n)] });
    await expect(approveSignRequest(req({ entryXdr: b64(transfer) }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      `refused: calls ${TESTNET.usdcSac}, not the identity registry`,
    );
    expect(w.calls).toBe(0);
    expect(r.seen).toHaveLength(0);
  });

  it('refuses another network, a kind that does not match the entry, a failed simulation, and a declined confirmation', async () => {
    const w = walletSpy();
    await expect(approveSignRequest(req({ networkPassphrase: Networks.PUBLIC }), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow('refused: wrong network');
    const registered = { approval: await approvedRegistration(), txHash: REGISTER_TX };
    await expect(approveSignRequest(req({ kind: 'bind' }), w, { rpc: chain(registered.approval).rpc, uriPrefix: prefix, confirm: yes, registered })).rejects.toThrow(
      'refused: the request says bind but the entry is register_with_uri',
    );
    const failing = { ...rpcAsking().rpc, simulateTransaction: async () => simError('HostError: Error(Auth, InvalidAction)') };
    await expect(approveSignRequest(req(), w, { rpc: failing, uriPrefix: prefix, confirm: yes })).rejects.toThrow('refused: the network rejects this call');
    await expect(approveSignRequest(req(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: async () => false })).rejects.toThrow('refused: you declined');
    expect(w.calls).toBe(0);
  });

  it('a bind must name the agent wallet the request carries', async () => {
    const w = walletSpy();
    const attacker = Keypair.random().publicKey();
    const registered = { approval: await approvedRegistration(), txHash: REGISTER_TX };
    const r = chain(registered.approval);
    await expect(
      approveSignRequest(req({ kind: 'bind', entryXdr: b64(bindEntry(42, attacker)) }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered }),
    ).rejects.toThrow(/binds a different wallet/);
    expect(w.calls).toBe(0);
  });
});

describe('approveSignRequest: signature expiry is clamped to the browser’s own ledger view', () => {
  it('the window covers the worst-case sponsor-lock wait: 30 ledgers (~150 s) > 120 s acquire cap + build', () => {
    expect(MAX_SIGNATURE_LEDGERS).toBe(30);
  });

  it('signs with latest + 30 when the server asks for longer', async () => {
    const w = walletSpy();
    const out = await approveSignRequest(req({ validUntilLedger: LATEST + 100 }), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes });
    expect(w.expiries).toEqual([LATEST + 30]);
    expect(expiryOf(out.signedEntryXdr)).toBe(LATEST + 30);
  });

  it('keeps the server expiry when it is already shorter', async () => {
    const w = walletSpy();
    const out = await approveSignRequest(req({ validUntilLedger: LATEST + 5 }), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes });
    expect(w.expiries).toEqual([LATEST + 5]);
    expect(expiryOf(out.signedEntryXdr)).toBe(LATEST + 5);
  });

  it('counts the time the owner took from its own clock, so a slow confirm does not eat the window', async () => {
    const w = walletSpy();
    let t = 1_000_000;
    await approveSignRequest(req({ validUntilLedger: LATEST + 100 }), w, {
      rpc: rpcAsking().rpc,
      uriPrefix: prefix,
      now: () => t,
      confirm: async () => ((t += 20_000), true), // 20 s at 6 s a ledger: at least 3 ledgers have closed
    });
    expect(w.expiries).toEqual([LATEST + 3 + 30]);
  });

  it('refuses an already-expired request without a passkey prompt', async () => {
    const w = walletSpy();
    await expect(approveSignRequest(req({ validUntilLedger: LATEST }), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      'refused: the request has expired',
    );
    expect(w.calls).toBe(0);
  });

  it('a closed passkey prompt is a typed cancel (retryable, not a refusal)', async () => {
    // @simplewebauthn keeps the platform's name; some builds carry it only on `cause`.
    const named = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
    const caused = Object.assign(new Error('wrapped'), { cause: new DOMException('x', 'NotAllowedError') });
    for (const err of [named, caused]) {
      let t = 0;
      const w: OwnerWallet = { address: ownerC, signEntry: async () => ((t += 4000), Promise.reject(err)) }; // the prompt was open for 4 s
      const e = await approveSignRequest(req(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes, now: () => t }).catch((x: unknown) => x);
      expect(isCancelled(e)).toBe(true);
      expect(isRetryable(e)).toBe(true);
      expect((e as Error).message).not.toMatch(/^refused/);
    }
  });

  it('a generic wallet throw before anything was signed is retryable, not a refusal', async () => {
    const boom: OwnerWallet = { address: ownerC, signEntry: async () => Promise.reject(new Error('Failed to fetch context rule 0: rpc down')) };
    const e = await approveSignRequest(req(), boom, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes }).catch((x: unknown) => x);
    expect(isRetryable(e)).toBe(true);
    expect(isCancelled(e)).toBe(false);
    expect((e as Error).message).toMatch(/^unavailable: /);
  });

  it('the kit ValidationError stays a refusal', async () => {
    const bad: OwnerWallet = {
      address: ownerC,
      signEntry: async () => Promise.reject(Object.assign(new Error('The authorization entry is not for the connected smart account'), { name: 'ValidationError' })),
    };
    const e = await approveSignRequest(req(), bad, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes }).catch((x: unknown) => x);
    expect(isRetryable(e)).toBe(false);
    expect((e as Error).message).toBe('The authorization entry is not for the connected smart account');
  });

  it('refuses a signed entry that is not the approved call at the approved expiry', async () => {
    const lying: OwnerWallet = {
      address: ownerC,
      signEntry: async (entryXdr) => b64(signEntry(xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64'), LATEST + 500)),
    };
    await expect(approveSignRequest(req(), lying, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      'refused: the wallet returned a different signature than approved',
    );
    const swapped: OwnerWallet = {
      address: ownerC,
      signEntry: async (_x, v) => b64(signEntry(bindEntry(), v)),
    };
    await expect(approveSignRequest(req(), swapped, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      'refused: the wallet returned a different signature than approved',
    );
  });
});

describe('approveSignRequest: the bind’s agent id comes from the chain, never the server', () => {
  it('reads the id from the register tx the owner signed, confirms it on the registry, then signs', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const r = chain(approval);
    const out = await approveSignRequest(bindReq(), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } });
    expect(w.calls).toBe(1);
    expect(out.call).toEqual({ fn: 'set_agent_wallet', owner: ownerC, agentId: 42, wallet: agentG });
    expect(out.summary).toBe(`Let agent #42 act with its own wallet ${agentG}.`);
    expect(r.txReads).toEqual([REGISTER_TX]);
    const views = r.seen.map((tx) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString());
    expect(views.sort()).toEqual(['agent_uri', 'find_owner', 'get_agent_wallet', 'set_agent_wallet']);
    for (const tx of r.seen) expect(tx.source).toBe(sponsor);
  });

  // An unbound agent: the registry's wallet is its owner (as registered) or none; any other address is bound.
  for (const [name, wallet] of [['its owner (as stellar-8004 registers it)', ownerC], ['unset', null]] as const) {
    it(`accepts an agent whose wallet is ${name} as unbound`, async () => {
      const approval = await approvedRegistration();
      const w = walletSpy();
      const r = chain(approval, { agents: { 42: { owner: ownerC, wallet, uri } } });
      const out = await approveSignRequest(bindReq(), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } });
      expect(out.call).toEqual({ fn: 'set_agent_wallet', owner: ownerC, agentId: 42, wallet: agentG });
      expect(w.calls).toBe(1);
    });
  }

  it('takes the register tx hash from the request when the browser holds only its approval', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const r = chain(approval);
    const out = await approveSignRequest(bindReq({ registerTx: REGISTER_TX }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered: { approval } });
    expect(out.call).toEqual({ fn: 'set_agent_wallet', owner: ownerC, agentId: 42, wallet: agentG });
    expect(r.txReads).toEqual([REGISTER_TX]);
  });

  it('refuses a bind that names no register tx, before any read or prompt', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const r = chain(approval);
    await expect(approveSignRequest(bindReq({ registerTx: null }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered: { approval } })).rejects.toThrow(
      'refused: the bind names no registration tx',
    );
    expect([w.calls, r.txReads.length]).toEqual([0, 0]);
  });

  it('refuses a bind with no registration the owner approved', async () => {
    const w = walletSpy();
    await expect(approveSignRequest(bindReq(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      'refused: there is no registration you approved to bind',
    );
    expect(w.calls).toBe(0);
  });

  it('refuses when the entry acts on another agent than the one the register tx created', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const r = chain(approval, {
      agents: { 42: { owner: ownerC, wallet: null, uri }, 41: { owner: ownerC, wallet: null, uri } },
    });
    await expect(
      approveSignRequest(bindReq({ entryXdr: b64(bindEntry(41)) }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } }),
    ).rejects.toThrow('refused: acts on agent #41, not the one you selected (#42)');
    expect(w.calls).toBe(0);
  });

  const refusals: [string, ChainState, string][] = [
    ['the register tx is unknown', { status: 'NOT_FOUND' }, 'unavailable: the registration is not on chain yet'],
    ['the register tx failed', { status: 'FAILED' }, 'refused: the registration is not on chain'],
    ['the register tx does not carry the owner’s signature', { registerAuth: () => [signEntry(registerEntry(), LATEST + 7)] }, 'refused: the registration tx does not carry your approval'],
    ['the register tx calls another function', { registerFn: 'register_full' }, 'refused: the registration tx is not your register_with_uri call'],
    ['the register tx registers another URI', { registerUri: `${prefix}11111111-2222-3333-4444-555555555555/agent.json` }, 'refused: the registration tx is not your register_with_uri call'],
    ['the register tx returned no id', { returnValue: undefined }, 'refused: the registration tx returned no agent id'],
    ['the agent is owned by someone else', { agents: { 42: { owner: contractAddress(9), wallet: null, uri } } }, 'refused: agent #42 is not owned by your wallet'],
    ['the agent already has a wallet', { agents: { 42: { owner: ownerC, wallet: Keypair.random().publicKey(), uri } } }, 'refused: agent #42 already has a wallet'],
    ['the agent URI changed', { agents: { 42: { owner: ownerC, wallet: null, uri: `${prefix}x/agent.json` } } }, 'refused: agent #42 is not described at the URI you approved'],
    ['the register tx has more than one op', { extraOp: true }, 'refused: the registration tx is not your register_with_uri call'],
    ['the register tx calls another contract', { registerContract: contractAddress(3) }, 'refused: the registration tx is not your register_with_uri call'],
    ['the register tx names another owner', { registerOwner: contractAddress(9) }, 'refused: the registration tx is not your register_with_uri call'],
    ['the agent does not exist', { agents: {} }, 'unavailable: cannot read agent #42 from the registry'],
  ];
  for (const [name, state, message] of refusals) {
    it(`refuses when ${name}, before any passkey prompt`, async () => {
      const approval = await approvedRegistration();
      const w = walletSpy();
      await expect(
        approveSignRequest(bindReq(), w, { rpc: chain(approval, state).rpc, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } }),
      ).rejects.toThrow(message);
      expect(w.calls).toBe(0);
    });
  }

  it('refuses a registration approval that was not a register call', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const notRegister: Approval = { ...approval, call: { fn: 'unset_agent_wallet', owner: ownerC, agentId: 42 } };
    await expect(
      approveSignRequest(bindReq(), w, { rpc: chain(approval).rpc, uriPrefix: prefix, confirm: yes, registered: { approval: notRegister, txHash: REGISTER_TX } }),
    ).rejects.toThrow('refused: there is no registration you approved to bind');
    expect(w.calls).toBe(0);
  });
});

describe('approveSignRequest: hardening (fix round 1)', () => {
  it('refuses a server expiry that is not a safe positive integer, before any read or prompt', async () => {
    for (const bad of [0, -1, 5000.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      const w = walletSpy();
      const r = rpcAsking();
      await expect(approveSignRequest(req({ validUntilLedger: bad }), w, { rpc: r.rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
        'refused: the request has an invalid expiry',
      );
      expect(w.calls).toBe(0);
      expect(r.seen).toHaveLength(0);
    }
  });

  it('refuses when the register tx cannot be read', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const rpcBroken = {
      ...chain(approval).rpc,
      getTransaction: async (): Promise<rpc.Api.GetTransactionResponse> => {
        throw new Error('503');
      },
    };
    await expect(
      approveSignRequest(bindReq(), w, { rpc: rpcBroken, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } }),
    ).rejects.toThrow('unavailable: cannot read the registration tx');
    expect(w.calls).toBe(0);
  });

  it('refuses when the latest ledger cannot be read or is not a ledger number', async () => {
    const latestFakes: (() => Promise<{ sequence: number }>)[] = [
      async () => {
        throw new Error('503');
      },
      async () => ({ sequence: Number.NaN }),
      async () => ({ sequence: 0 }),
      async () => ({ sequence: 4999.5 }),
      async () => ({}) as { sequence: number },
    ];
    for (const getLatestLedger of latestFakes) {
      const w = walletSpy();
      await expect(
        approveSignRequest(req(), w, { rpc: { ...rpcAsking().rpc, getLatestLedger }, uriPrefix: prefix, confirm: yes }),
      ).rejects.toThrow('unavailable: cannot read the latest ledger');
      expect(w.calls).toBe(0);
    }
  });

  it('a registration not on chain yet, or a failed read, is retryable; a policy refusal is not', async () => {
    const approval = await approvedRegistration();
    const base = chain(approval).rpc;
    const run = (rpcX: typeof base, r = bindReq()) =>
      approveSignRequest(r, walletSpy(), { rpc: rpcX, uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } }).catch((e) => e);
    const lag = await run({ ...base, getTransaction: async () => ({ status: 'NOT_FOUND' }) as never });
    expect(isRetryable(lag)).toBe(true);
    expect(lag.message).toBe('unavailable: the registration is not on chain yet');
    const down = await run({
      ...base,
      getTransaction: async () => {
        throw new Error('503');
      },
    });
    expect(isRetryable(down)).toBe(true);
    expect(isRetryable(await run({ ...base, getTransaction: async () => ({ status: 'FAILED' }) as never }))).toBe(false);
    const policy = await run(base, bindReq({ networkPassphrase: 'Other' }));
    expect(isRetryable(policy)).toBe(false);
    expect(policy.message).toBe('refused: wrong network');
    const declined = await approveSignRequest(req(), walletSpy(), { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: async () => false }).catch((e) => e);
    expect(isRetryable(declined)).toBe(false);
  });

  it('a bind simulation error is retryable (the node may not know the agent yet); a register one is a refusal', async () => {
    const approval = await approvedRegistration();
    const base = chain(approval).rpc;
    const failSim = <T extends { simulateTransaction: (tx: Transaction) => Promise<rpc.Api.SimulateTransactionResponse> }>(inner: T): T => ({
      ...inner,
      simulateTransaction: async (tx: Transaction) => {
        const fn = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString();
        return fn === 'set_agent_wallet' || fn === 'register_with_uri' ? simError('HostError: Error(Auth, InvalidAction)') : inner.simulateTransaction(tx);
      },
    });
    const bind = await approveSignRequest(bindReq(), walletSpy(), { rpc: failSim(base), uriPrefix: prefix, confirm: yes, registered: { approval, txHash: REGISTER_TX } }).catch((e) => e);
    expect(isRetryable(bind)).toBe(true);
    const reg = await approveSignRequest(req(), walletSpy(), { rpc: failSim(rpcAsking().rpc), uriPrefix: prefix, confirm: yes }).catch((e) => e);
    expect(isRetryable(reg)).toBe(false);
    const missing = { simulateTransaction: async () => simError('HostError: Error(Storage, MissingValue)') };
    expect(await simulateEntry(b64(registerEntry()), { rpc: missing, source: sponsor, passphrase: TESTNET.passphrase })).toMatchObject({ ok: false, retryable: true });
  });

  it('refuses when the simulation itself throws', async () => {
    const w = walletSpy();
    const throwing = {
      ...rpcAsking().rpc,
      simulateTransaction: async (): Promise<rpc.Api.SimulateTransactionResponse> => {
        throw new Error('network down');
      },
    };
    await expect(approveSignRequest(req(), w, { rpc: throwing, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
      'unavailable: simulation unavailable',
    );
    expect(w.calls).toBe(0);
  });

  it('refuses a registration approved by another wallet', async () => {
    const approval = await approvedRegistration();
    const w = walletSpy();
    const otherOwner: Approval = { ...approval, call: { fn: 'register_with_uri', owner: contractAddress(9), agentUri: uri } };
    await expect(
      approveSignRequest(bindReq(), w, { rpc: chain(approval).rpc, uriPrefix: prefix, confirm: yes, registered: { approval: otherOwner, txHash: REGISTER_TX } }),
    ).rejects.toThrow('refused: there is no registration you approved to bind');
    expect(w.calls).toBe(0);
  });

  const badSignatures: [string, OwnerWallet['signEntry']][] = [
    ['another address', async (_x, v) => b64(signEntry(authEntry({ signer: contractAddress(9), fn: 'register_with_uri', args: registerArgs }), v))],
    ['another nonce', async (_x, v) => b64(signEntry(authEntry({ signer: ownerC, nonce: 1234, fn: 'register_with_uri', args: registerArgs }), v))],
    ['undecodable XDR', async () => 'not-an-auth-entry'],
  ];
  for (const [name, signEntryFn] of badSignatures) {
    it(`refuses a signed entry with ${name}`, async () => {
      const w: OwnerWallet = { address: ownerC, signEntry: signEntryFn };
      await expect(approveSignRequest(req(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes })).rejects.toThrow(
        'refused: the wallet returned a different signature than approved',
      );
    });
  }
});


describe('approveSignRequest: no network between the owner’s press and the passkey prompt', () => {
  it('prepares the wallet and reads the ledger before it asks, then touches nothing before signing', async () => {
    const order: string[] = [];
    const r = rpcAsking();
    let reads = 0;
    const rpcCounting = { ...r.rpc, getLatestLedger: async () => (reads++, order.push('ledger'), { sequence: LATEST }) };
    const w: OwnerWallet = {
      address: ownerC,
      prepare: async () => void order.push('prepare'),
      signEntry: async (entryXdr, v) => {
        order.push(`sign after ${reads} ledger reads`);
        return b64(signEntry(xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64'), v));
      },
    };
    await approveSignRequest(req(), w, {
      rpc: rpcCounting,
      uriPrefix: prefix,
      confirm: async () => (order.push(`confirm after ${reads} ledger reads`), true),
    });
    expect(order.filter((o) => o === 'prepare' || o === 'ledger')).toHaveLength(2);
    const asked = order.indexOf('confirm after 1 ledger reads');
    expect(asked).toBeGreaterThan(order.indexOf('prepare'));
    expect(asked).toBeGreaterThan(order.indexOf('ledger'));
    // The ledger was read once, before the question; the press only extrapolates.
    expect(order.slice(asked + 1)).toEqual(['sign after 1 ledger reads']);
  });

  it('keeps the ledger fresh while the question is open, so a long wait still signs a window that is right', async () => {
    const w = walletSpy();
    let latest = LATEST;
    const r = rpcAsking();
    const rpcNow = { ...r.rpc, getLatestLedger: async () => ({ sequence: latest }) };
    await approveSignRequest(req({ validUntilLedger: LATEST + 500 }), w, {
      rpc: rpcNow,
      uriPrefix: prefix,
      ledgerRefreshMs: 5,
      confirm: async () => {
        latest = LATEST + 20;
        await new Promise((res) => setTimeout(res, 60));
        return true;
      },
    });
    expect(w.expiries).toEqual([LATEST + 20 + 30]);
  });

  it('stops refreshing once the question is answered', async () => {
    let reads = 0;
    const r = rpcAsking();
    const rpcCounting = { ...r.rpc, getLatestLedger: async () => (reads++, { sequence: LATEST }) };
    await approveSignRequest(req(), walletSpy(), { rpc: rpcCounting, uriPrefix: prefix, ledgerRefreshMs: 5, confirm: yes });
    const after = reads;
    await new Promise((res) => setTimeout(res, 40));
    expect(reads).toBe(after);
  });

  it('reads the ledger again after the press only when the last read is too old to trust', async () => {
    const w = walletSpy();
    let t = 0;
    let reads = 0;
    const r = rpcAsking();
    const rpcNow = { ...r.rpc, getLatestLedger: async () => (reads++, { sequence: LATEST + (reads - 1) * 10 }) };
    await approveSignRequest(req({ validUntilLedger: LATEST + 500 }), w, {
      rpc: rpcNow,
      uriPrefix: prefix,
      now: () => t,
      confirm: async () => ((t += 120_000), true), // refreshes failed or never ran for two minutes
    });
    expect(reads).toBe(2);
    expect(w.expiries).toEqual([LATEST + 10 + 30]);
  });

  it('a request that looks expired by the clock is checked against a fresh ledger before it is refused', async () => {
    const w = walletSpy();
    let t = 0;
    let reads = 0;
    const r = rpcAsking();
    // First read: close to the end of the window. Second (fresh) read: still inside it, so it can be signed.
    const rpcNow = { ...r.rpc, getLatestLedger: async () => (reads++, { sequence: reads === 1 ? LATEST + 90 : LATEST + 91 }) };
    await approveSignRequest(req({ validUntilLedger: LATEST + 100 }), w, {
      rpc: rpcNow,
      uriPrefix: prefix,
      now: () => t,
      confirm: async () => ((t += 100_000), true), // the clock says ~16 ledgers closed, past the window
    });
    expect(reads).toBe(2);
    expect(w.expiries).toEqual([LATEST + 100]);
  });

  it('a prompt that fails at once never showed anything: retryable, not "you cancelled"', async () => {
    const instant = Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
    let t = 0;
    const w: OwnerWallet = { address: ownerC, signEntry: async () => ((t += 20), Promise.reject(instant)) };
    const e = await approveSignRequest(req(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: yes, now: () => t }).catch((x: unknown) => x);
    expect(isRetryable(e)).toBe(true);
    expect(isCancelled(e)).toBe(false);
  });

  it('a wallet that cannot get ready is retryable and nothing was asked', async () => {
    let asked = false;
    const w: OwnerWallet = { address: ownerC, prepare: async () => Promise.reject(new Error('rpc down')), signEntry: async () => 'x' };
    const e = await approveSignRequest(req(), w, { rpc: rpcAsking().rpc, uriPrefix: prefix, confirm: async () => ((asked = true), true) }).catch((x: unknown) => x);
    expect(isRetryable(e)).toBe(true);
    expect(asked).toBe(false);
  });
});

describe('findPasskeySigner', () => {
  const credentialId = Buffer.from('credential-bytes-1').toString('base64url');
  const external = (tail: Buffer) => ({ tag: 'External', values: ['CVERIFIER', Buffer.concat([Buffer.alloc(65, 4), tail])] });
  const kitWith = (signers: unknown[]) => ({ rules: { get: async (id: number) => (id === 0 ? { result: { signers } } : Promise.reject(new Error('rule'))) } }) as never;

  it('returns the External signer whose key data ends with the credential id', async () => {
    const mine = external(Buffer.from('credential-bytes-1'));
    const found = await findPasskeySigner(kitWith([{ tag: 'Delegated', values: ['GABC'] }, external(Buffer.from('other-credential-2')), mine]), credentialId);
    expect(found).toBe(mine);
  });

  it('throws when the wallet has no signer for this passkey', async () => {
    await expect(findPasskeySigner(kitWith([external(Buffer.from('other-credential-2'))]), credentialId)).rejects.toThrow('no signer for this passkey');
  });
});
