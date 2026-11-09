// GENERATED, do not edit; source apps/api/src/owner-client
/**
 * The registry agent id a bind acts on, established by the browser from chain data alone
 * (carry-forward, Task 10). The server's word is never used: it only supplies the register tx
 * hash, and that hash is accepted only if the tx it names carries the very entry the owner signed.
 *
 * 1. The register tx succeeded, its single op is register_with_uri(owner, approvedUri) on the
 *    registry, and its auth carries the owner's signed entry byte for byte (that nonce was spent
 *    there and nowhere else). Its return value is the agent id.
 * 2. The registry, read now, agrees: find_owner(id) is the owner, get_agent_wallet(id) is unbound
 *    (the owner itself, which stellar-8004 sets at registration, or none), agent_uri(id) is the approved URI.
 */
import { Account, Address, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';
import type { SimulateRpc } from './simulate';

export interface RegistryRpc extends SimulateRpc {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface RegistryContext {
  rpc: RegistryRpc;
  /** The connected wallet (C…). */
  owner: string;
  registry: string;
  /** Simulation source (the sponsor); see simulate.ts. */
  source: string;
  passphrase: string;
}

/** What the owner approved at register time, plus the tx hash the platform submitted it in. */
export interface ApprovedRegistration {
  signedEntryXdr: string;
  agentUri: string;
  txHash: string;
}

export type AgentIdResult = { ok: true; agentId: number } | { ok: false; reason: string; retryable?: true };

const refuse = (reason: string): AgentIdResult => ({ ok: false, reason });
/** The chain could not be read (or has not caught up): not a verdict on the registration. */
const unavailable = (reason: string): AgentIdResult => ({ ok: false, reason, retryable: true });
const u32Of = (v: xdr.ScVal | undefined): number | null => (v && v.switch() === xdr.ScValType.scvU32() ? v.u32() : null);
const strOf = (v: xdr.ScVal | undefined): string | null => (v && v.switch() === xdr.ScValType.scvString() ? v.str().toString() : null);
function addrOf(v: xdr.ScVal | undefined): string | null {
  if (!v || v.switch() !== xdr.ScValType.scvAddress()) return null;
  try {
    return Address.fromScVal(v).toString();
  } catch {
    return null;
  }
}

/** The single register_with_uri op of a (possibly fee-bumped) envelope, or null. */
function registerOp(envelope: xdr.TransactionEnvelope, passphrase: string) {
  const parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  const tx = ('innerTransaction' in parsed ? parsed.innerTransaction : parsed) as Transaction;
  if (tx.operations.length !== 1) return null;
  const op = tx.operations[0] as unknown as { type: string; func?: xdr.HostFunction; auth?: xdr.SorobanAuthorizationEntry[] };
  if (op.type !== 'invokeHostFunction' || !op.func) return null;
  if (op.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  return { call: op.func.invokeContract(), auth: op.auth ?? [] };
}

async function view(ctx: RegistryContext, fn: string, agentId: number): Promise<xdr.ScVal | null> {
  const tx = new TransactionBuilder(new Account(ctx.source, '0'), { fee: BASE_FEE, networkPassphrase: ctx.passphrase })
    .addOperation(new Contract(ctx.registry).call(fn, nativeToScVal(agentId, { type: 'u32' })))
    .setTimeout(300)
    .build();
  try {
    const sim = await ctx.rpc.simulateTransaction(tx);
    return rpc.Api.isSimulationSuccess(sim) && sim.result ? sim.result.retval : null;
  } catch {
    return null;
  }
}

export async function registeredAgentId(reg: ApprovedRegistration, ctx: RegistryContext): Promise<AgentIdResult> {
  let res: rpc.Api.GetTransactionResponse;
  try {
    res = await ctx.rpc.getTransaction(reg.txHash);
  } catch {
    return unavailable('cannot read the registration tx');
  }
  if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return unavailable('the registration is not on chain yet');
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return refuse('the registration is not on chain');

  let op: ReturnType<typeof registerOp>;
  try {
    op = registerOp(res.envelopeXdr, ctx.passphrase);
  } catch {
    op = null;
  }
  const args = op?.call.args() ?? [];
  if (
    !op ||
    Address.fromScAddress(op.call.contractAddress()).toString() !== ctx.registry ||
    op.call.functionName().toString() !== 'register_with_uri' ||
    args.length !== 2 ||
    addrOf(args[0]) !== ctx.owner ||
    strOf(args[1]) !== reg.agentUri
  ) {
    return refuse('the registration tx is not your register_with_uri call');
  }
  if (!op.auth.some((e) => e.toXDR('base64') === reg.signedEntryXdr)) return refuse('the registration tx does not carry your approval');

  const agentId = u32Of(res.returnValue);
  if (agentId === null) return refuse('the registration tx returned no agent id');

  const [owner, wallet, uri] = await Promise.all([view(ctx, 'find_owner', agentId), view(ctx, 'get_agent_wallet', agentId), view(ctx, 'agent_uri', agentId)]);
  if (owner === null || wallet === null || uri === null) return unavailable(`cannot read agent #${agentId} from the registry`);
  if (addrOf(owner) !== ctx.owner) return refuse(`agent #${agentId} is not owned by your wallet`);
  // stellar-8004 sets a new agent's wallet to its owner at registration: unbound reads as the owner (or none).
  if (wallet.switch() !== xdr.ScValType.scvVoid() && addrOf(wallet) !== ctx.owner) return refuse(`agent #${agentId} already has a wallet`);
  if (strOf(uri) !== reg.agentUri) return refuse(`agent #${agentId} is not described at the URI you approved`);
  return { ok: true, agentId };
}
