import {
  Account,
  Address,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import type { SorobanSeam } from 'agentenact/create';
import type { ChainRpc } from '../../src/chain/index.js';
import { TESTNET } from '../../src/owner-client/testnet.js';

/** A parsed RPC simulation success, shaped like rpc.Server returns it (resource fee 2.5e5 stroops). */
export const simSuccess = (auth: xdr.SorobanAuthorizationEntry[] = [], retval: xdr.ScVal = xdr.ScVal.scvVoid()) =>
  ({
    _parsed: true,
    id: '1',
    latestLedger: 5000,
    events: [],
    minResourceFee: '250000',
    transactionData: new SorobanDataBuilder().setResourceFee(250_000),
    result: { auth, retval },
  }) as unknown as rpc.Api.SimulateTransactionResponse;

export const simError = (message: string) =>
  ({ _parsed: true, id: '1', latestLedger: 5000, events: [], error: message }) as unknown as rpc.Api.SimulateTransactionResponse;

const callOf = (tx: Transaction) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
const authOf = (tx: Transaction) => (tx.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];

const entryFor = (signer: string, fn: string, args: xdr.ScVal[]) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: new xdr.Int64(777),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TESTNET.registry).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });

/**
 * The auth entries a testnet recording simulation returns for a registry call: the owner (args[0])
 * authorises register_with_uri; owner and agent (args[2]) authorise set_agent_wallet. An enforcing
 * build (auth already attached) gets none.
 */
export function recordingAuth(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
  if (authOf(tx).length > 0) return [];
  const call = callOf(tx);
  const fn = call.functionName().toString();
  const args = call.args();
  const owner = Address.fromScVal(args[0]!).toString();
  return fn === 'register_with_uri'
    ? [entryFor(owner, fn, args)]
    : [entryFor(owner, fn, args), entryFor(Address.fromScVal(args[2]!).toString(), fn, args)];
}

/**
 * A ChainRpc + Horizon fetch that behave like testnet behind the REAL chain.soroban / horizonSubmit:
 * one shared account sequence that only an accepted tx advances, and a tx whose sequence is not
 * current + 1 is refused as tx_bad_seq (a broken sponsor lock shows up as `badSeq > 0`). Register
 * txs return consecutive agent ids from 42. Hashes are the real tx hashes. GET /accounts/<G> is 200 only
 * for accounts an accepted tx created, else 404.
 */
export function fakeChainRpc() {
  const r = { seq: 100n, accepted: [] as Transaction[], sent: [] as Transaction[], submitted: [] as Transaction[], badSeq: 0, nextId: 42 };
  const ids = new Map<string, number>();
  const accept = (tx: Transaction) => {
    if (BigInt(tx.sequence) !== r.seq + 1n) {
      r.badSeq++;
      return false;
    }
    r.seq++;
    r.accepted.push(tx);
    return true;
  };
  const rpcFake: ChainRpc = {
    getAccount: async (id) => new Account(id, r.seq.toString()),
    simulateTransaction: async (tx) => simSuccess(recordingAuth(tx)),
    sendTransaction: async (t) => {
      const tx = t as Transaction;
      const hash = tx.hash().toString('hex');
      if (!accept(tx)) return { status: 'ERROR', hash, errorResult: 'tx_bad_seq', latestLedger: 5001, latestLedgerCloseTime: '1759572000' } as unknown as rpc.Api.SendTransactionResponse;
      r.sent.push(tx);
      if (callOf(tx).functionName().toString() === 'register_with_uri') ids.set(hash, r.nextId++);
      return { status: 'PENDING', hash, latestLedger: 5001, latestLedgerCloseTime: '1759572000' } as unknown as rpc.Api.SendTransactionResponse;
    },
    getLatestLedger: async () => ({ sequence: 5000 }),
    pollTransaction: async (hash) => {
      const id = ids.get(hash);
      return { status: 'SUCCESS', ...(id !== undefined ? { returnValue: nativeToScVal(id, { type: 'u32' }) } : {}) } as unknown as rpc.Api.GetTransactionResponse;
    },
  };
  const created = new Set<string>();
  const fetchFake = (async (url: string, init?: { body: string }) => {
    const account = /\/accounts\/(G[A-Z2-7]{55})$/.exec(url);
    if (account) return created.has(account[1]!) ? new Response(JSON.stringify({ id: account[1] }), { status: 200 }) : new Response('{"status":404}', { status: 404 });
    const tx = TransactionBuilder.fromXDR(decodeURIComponent(init!.body.replace(/^tx=/, '')), TESTNET.passphrase) as Transaction;
    if (!accept(tx)) {
      return new Response(JSON.stringify({ title: 'Transaction Failed', extras: { result_codes: { transaction: 'tx_bad_seq' } } }), { status: 400 });
    }
    for (const op of tx.operations) if (op.type === 'createAccount') created.add(op.destination);
    r.submitted.push(tx);
    return new Response(JSON.stringify({ hash: tx.hash().toString('hex'), ledger: 5001, successful: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { r, rpc: rpcFake, fetch: fetchFake };
}

/**
 * A SorobanSeam that behaves like testnet for createStellarAgent's auth-owner mode: the recording
 * simulation asks the owner (and, for the bind, the agent) to authorise exactly the built call; the
 * register tx returns agentId 42; hashes are a…/b…/c… for account/register/bind.
 */
export function fakeSoroban() {
  const r = { seq: 9, sent: [] as Transaction[], submitted: [] as string[] };
  const assembled = (tx: Transaction) =>
    TransactionBuilder.cloneFrom(tx, { fee: tx.fee, sorobanData: new SorobanDataBuilder().setResourceFee(250_000).build() }).build();
  const soroban: SorobanSeam = {
    getAccount: async (id) => new Account(id, String(r.seq)),
    register: async () => {
      throw new Error('register() is sponsor-mode only');
    },
    latestLedger: async () => 5000,
    prepare: async (tx) => ({ prepared: assembled(tx), auth: recordingAuth(tx) }),
    send: async (tx) => {
      const fn = callOf(tx as Transaction).functionName().toString();
      r.sent.push(tx as Transaction);
      r.seq++;
      return { hash: (fn === 'register_with_uri' ? 'b' : 'c').repeat(64) };
    },
    confirm: async (hash) => (hash === 'b'.repeat(64) ? nativeToScVal(42, { type: 'u32' }) : undefined),
  };
  const horizonSubmit = async (x: string) => {
    r.submitted.push(x);
    r.seq++;
    return { hash: 'a'.repeat(64) };
  };
  return { r, soroban, horizonSubmit };
}
