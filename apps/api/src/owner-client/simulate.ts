/**
 * Before a passkey prompt the browser asks the network itself what the call needs: it rebuilds the
 * entry's call, simulates it in recording mode, and requires an owner entry for the identical
 * invocation. Precondition: checkEntry(entry) passed (address credentials, a contract call).
 *
 * Source and sequence: the sponsor at sequence '0'. Simulation neither checks the sequence nor
 * requires the source to exist (verified on testnet 2026-10-04 with a random unfunded source:
 * recording mode still returned the owner's register_with_uri entry).
 */
import { Account, Address, BASE_FEE, Operation, TransactionBuilder, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';

export interface SimulateRpc {
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

/** `retryable`: the network could not answer (transport error, or an entry it has not seen yet), not a verdict on the call. */
export type SimulateResult = { ok: true } | { ok: false; reason: string; retryable?: true };

const MISSING_ENTRY = /missing|not found|no such|archived|does not exist/i;

export async function simulateEntry(entryXdr: string, ctx: { rpc: SimulateRpc; source: string; passphrase: string; /** Treat any simulation error as retryable (a bind: the node may not have seen the new agent yet). */ anyErrorRetryable?: boolean }): Promise<SimulateResult> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  const signer = Address.fromScAddress(entry.credentials().address().address()).toString();
  const call = entry.rootInvocation().function().contractFn();
  const tx = new TransactionBuilder(new Account(ctx.source, '0'), { fee: BASE_FEE, networkPassphrase: ctx.passphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: Address.fromScAddress(call.contractAddress()).toString(),
        function: call.functionName().toString(),
        args: call.args(),
      }),
    )
    .setTimeout(300)
    .build();
  let sim: rpc.Api.SimulateTransactionResponse;
  try {
    sim = await ctx.rpc.simulateTransaction(tx);
  } catch {
    return { ok: false, reason: 'simulation unavailable', retryable: true };
  }
  if (rpc.Api.isSimulationError(sim)) {
    const reason = `the network rejects this call: ${sim.error}`;
    return ctx.anyErrorRetryable || MISSING_ENTRY.test(sim.error) ? { ok: false, reason, retryable: true } : { ok: false, reason };
  }
  const auth = rpc.Api.isSimulationSuccess(sim) ? (sim.result?.auth ?? []) : [];
  const want = entry.rootInvocation().toXDR('base64');
  const asked = auth.some(
    (a) =>
      a.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
      Address.fromScAddress(a.credentials().address().address()).toString() === signer &&
      a.rootInvocation().toXDR('base64') === want,
  );
  return asked ? { ok: true } : { ok: false, reason: 'the call does not ask your wallet for this authorisation' };
}
