/**
 * Realistic Soroban fixtures for the signing gate, built with @stellar/stellar-sdk: real auth entries
 * (as a recording simulation returns them), a real USDC SAC transfer, nested sub-invocations, and a
 * chain that answers like testnet (a fee-bumped register tx carrying the owner's signed entry).
 */
import { Account, Address, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';
import type { Approval, OwnerRpc, OwnerWallet } from '@/lib/signing-flow';
import { TESTNET } from '@/mirror/owner-client/testnet';

export const LATEST = 5000;
export const REGISTER_TX = 'b'.repeat(64);
export const contractAddress = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill));

export const scv = {
  addr: (a: string) => Address.fromString(a).toScVal(),
  str: (s: string) => nativeToScVal(s, { type: 'string' }),
  u32: (n: number) => nativeToScVal(n, { type: 'u32' }),
  i128: (n: bigint) => nativeToScVal(n, { type: 'i128' }),
};

export function invocation(contract: string, fn: string, args: xdr.ScVal[], sub: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contract).toScAddress(), functionName: fn, args }),
    ),
    subInvocations: sub,
  });
}

/** An unsigned entry as a recording simulation returns it. */
export function authEntry(o: {
  signer: string;
  contract?: string;
  fn: string;
  args: xdr.ScVal[];
  sub?: xdr.SorobanAuthorizedInvocation[];
  nonce?: number;
}): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(o.signer).toScAddress(),
        nonce: new xdr.Int64(o.nonce ?? 777),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(o.contract ?? TESTNET.registry, o.fn, o.args, o.sub),
  });
}

export const b64 = (e: xdr.SorobanAuthorizationEntry) => e.toXDR('base64');

/** Stands in for the passkey: fills expiry and a non-void signature, keeps everything else. */
export function passkeySign(entryXdr: string, validUntil: number): string {
  const out = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  const c = out.credentials().address();
  c.signatureExpirationLedger(validUntil);
  c.signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
  return b64(out);
}

export const simSuccess = (auth: xdr.SorobanAuthorizationEntry[] = [], retval: xdr.ScVal = xdr.ScVal.scvVoid()) =>
  ({
    _parsed: true,
    id: '1',
    latestLedger: LATEST,
    events: [],
    minResourceFee: '250000',
    transactionData: new SorobanDataBuilder().setResourceFee(250_000),
    result: { auth, retval },
  }) as unknown as rpc.Api.SimulateTransactionResponse;

export const simError = (message: string) =>
  ({ _parsed: true, id: '1', latestLedger: LATEST, events: [], error: message }) as unknown as rpc.Api.SimulateTransactionResponse;

export interface FakeChain {
  rpc: OwnerRpc;
  /** Names of every contract function the browser simulated. */
  simulated: string[];
  txReads: string[];
}

/**
 * A testnet-shaped chain. Recording simulation asks the owner (and the agent, for a bind) to authorise
 * exactly the built call; the register tx is fee-bumped, carries whatever `registered()` returns as the
 * owner's signed entry and returned agent id 42; registry views answer for agent 42.
 */
export function fakeChain(o: {
  owner: string;
  sponsor: string;
  uri: string;
  /** The approval the register tx carries (read lazily: it exists only once the owner signed). */
  registered: () => Approval | null;
  simFails?: boolean;
}): FakeChain {
  const simulated: string[] = [];
  const txReads: string[] = [];
  const view = (fn: string): rpc.Api.SimulateTransactionResponse => {
    // stellar-8004 sets a new agent's wallet to its owner at registration (testnet agents 37/38).
    if (fn === 'find_owner' || fn === 'get_agent_wallet') return simSuccess([], scv.addr(o.owner));
    if (fn === 'agent_uri') return simSuccess([], scv.str(o.uri));
    return simError(`no such view ${fn}`);
  };
  return {
    simulated,
    txReads,
    rpc: {
      async simulateTransaction(tx: Transaction) {
        const call = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
        const fn = call.functionName().toString();
        const args = call.args();
        simulated.push(fn);
        if (fn === 'register_with_uri' || fn === 'set_agent_wallet') {
          if (o.simFails) return simError('HostError: Error(Auth, InvalidAction)');
          const auths = [authEntry({ signer: o.owner, nonce: 999_001, fn, args })];
          if (fn === 'set_agent_wallet') auths.push(authEntry({ signer: Address.fromScVal(args[2]!).toString(), nonce: 999_002, fn, args }));
          return simSuccess(auths);
        }
        return view(fn);
      },
      getLatestLedger: async () => ({ sequence: LATEST }),
      async getTransaction(hash: string) {
        txReads.push(hash);
        const approval = o.registered();
        if (!approval) return { status: 'NOT_FOUND', latestLedger: LATEST, latestLedgerCloseTime: 0, oldestLedger: 1, oldestLedgerCloseTime: 0, txHash: hash } as unknown as rpc.Api.GetTransactionResponse;
        const op = Operation.invokeContractFunction({
          contract: TESTNET.registry,
          function: 'register_with_uri',
          args: [scv.addr(o.owner), scv.str(o.uri)],
          auth: [xdr.SorobanAuthorizationEntry.fromXDR(approval.signedEntryXdr, 'base64')],
        });
        const built = new TransactionBuilder(new Account(o.sponsor, '41'), { fee: '100', networkPassphrase: TESTNET.passphrase }).addOperation(op).setTimeout(300).build();
        const inner = TransactionBuilder.cloneFrom(built, { fee: built.fee, sorobanData: new SorobanDataBuilder().setResourceFee(250_000).build() }).build();
        const feeBumped = TransactionBuilder.buildFeeBumpTransaction(o.sponsor, '2650000', inner, TESTNET.passphrase);
        return {
          status: 'SUCCESS',
          txHash: hash,
          latestLedger: LATEST,
          ledger: LATEST - 3,
          createdAt: 1_759_000_000,
          applicationOrder: 1,
          feeBump: true,
          envelopeXdr: feeBumped.toEnvelope(),
          returnValue: scv.u32(42),
        } as unknown as rpc.Api.GetTransactionResponse;
      },
    },
  };
}

/** The passkey wallet: records every signing prompt and returns a stand-in signature. */
export function walletSpy(address: string): OwnerWallet & { prompts: number } {
  const w = {
    address,
    prompts: 0,
    async signEntry(entryXdr: string, validUntil: number) {
      w.prompts++;
      return passkeySign(entryXdr, validUntil);
    },
  };
  return w;
}
