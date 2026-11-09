/**
 * The platform sponsor's signing policy: the exact transaction shapes the sponsor sources and pays for, and
 * nothing else. The vault (keys/vault.ts) runs it before it signs with the sponsor key it alone holds; the api's
 * chain unit runs the same check first, so a refusal costs no vault call and reads the same everywhere.
 *
 *   birth     the four sponsored-account ops for a new agent (zero balance, one USDC trustline)
 *   registry  one register_with_uri or set_agent_wallet call on the stellar-8004 registry
 *   wallet    one passkey smart-wallet deploy: our account wasm, the sponsor as deployer
 *   seal      a fee-bump paying for an agent's own check-seal tx (seals/tx.ts shape), at most SEAL_MAX_FEE_STROOPS
 *   close     a fee-bump paying for a deleted agent's own close tx (agents/close-tx.ts shape), at most CLOSE_MAX_FEE_STROOPS;
 *             where its money goes is the vault's check when it signs as the agent
 *   reserve   an agent's reserves changing hands (agents/reserve-tx.ts): the agent buys its own and the sponsor revokes, or
 *             the sponsor takes them back for a close; the agent's own ops need the agent's signature (the vault's check)
 *   credit    testnet USDC for a hosted agent (agents/credit-tx.ts): the sponsor buys exactly 1 USDC with its own XLM and
 *             sends it to the agent; which agent, and how often, is the vault's check
 *
 * Soroban auth entries signed by others are theirs to check. An entry the sponsor's own signature would
 * authorize (source-account credentials) must be the call itself with nothing under it.
 */
import { Address, Keypair, TransactionBuilder, xdr, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import type { StellarSigner } from 'agentenact/create';
import { TESTNET } from '../owner-client/testnet.js';
import { SEAL_MAX_FEE_STROOPS, sealShape } from '../seals/tx.js';
import { CLOSE_MAX_FEE_STROOPS, closeShape } from '../agents/close-tx.js';
import { reserveShape } from '../agents/reserve-tx.js';
import { creditShape } from '../agents/credit-tx.js';

/** Total-fee cap per sponsor-signed tx, in stroops: 100 XLM. See maxFee in createSponsorPolicy. */
export const DEFAULT_MAX_FEE_STROOPS = 1_000_000_000n;

export type SponsorTxKind = 'birth' | 'registry' | 'wallet' | 'seal' | 'close' | 'reserve' | 'credit';

export interface SponsorPolicy {
  /** The parsed tx and its kind when the sponsor may sign it; throws `chain: …` otherwise. Only a seal is a fee-bump. */
  check(txXdr: string, networkPassphrase: string): { tx: Transaction | FeeBumpTransaction; kind: SponsorTxKind; creditTo?: string };
}

const REGISTRY_FNS = new Set(['register_with_uri', 'set_agent_wallet']);
const refuse = () => new Error('chain: the sponsor refuses this transaction');
type Op = { type: string; source?: string; [k: string]: unknown };

export function createSponsorPolicy(o: { sponsorPublicKey: string; maxFeeStroops?: bigint }): SponsorPolicy {
  const sponsor = o.sponsorPublicKey;
  // Measured testnet fees: register_with_uri about 0.265 XLM (2,650,000 stroops), set_agent_wallet 61,156
  // stroops. Pubnet register_with_uri has simulated at 27.29 XLM (shared-contract rent spikes), so the cap
  // leaves room for spikes while still bounding a runaway fee.
  const maxFee = o.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;
  const isSponsor = (src?: string) => src === undefined || src === sponsor;

  const birth = (ops: Op[]) => {
    const count = (t: string) => ops.filter((op) => op.type === t).length;
    if (ops.length !== 4 || !['beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves'].every((t) => count(t) === 1)) return false;
    const agent = ops.find((op) => op.type === 'createAccount')?.destination as string | undefined;
    if (agent === undefined) return false;
    return ops.every((op) => {
      switch (op.type) {
        case 'createAccount':
          return /^0(\.0+)?$/.test(String(op.startingBalance)) && isSponsor(op.source);
        case 'beginSponsoringFutureReserves':
          return op.sponsoredId === agent && isSponsor(op.source);
        case 'changeTrust':
          // The sponsor pays the reserve of exactly one trustline: the library's classic testnet USDC.
          return op.source === agent && String(op.line) === TESTNET.usdc;
        case 'endSponsoringFutureReserves':
          return op.source === agent;
        default:
          return false;
      }
    });
  };

  /** Every entry the sponsor's tx signature would authorize is exactly `root`, with nothing under it. */
  const ownAuthIs = (op: Op, root: (f: xdr.SorobanAuthorizedFunction) => boolean) =>
    ((op.auth as xdr.SorobanAuthorizationEntry[] | undefined) ?? []).every(
      (e) =>
        e.credentials().switch().name !== 'sorobanCredentialsSourceAccount' ||
        (root(e.rootInvocation().function()) && e.rootInvocation().subInvocations().length === 0),
    );

  const registryCall = (op: Op) => {
    const func = op.func as xdr.HostFunction | undefined;
    if (op.source !== undefined || !func || func.switch().name !== 'hostFunctionTypeInvokeContract') return false;
    const ic = func.invokeContract();
    if (Address.fromScAddress(ic.contractAddress()).toString() !== TESTNET.registry || !REGISTRY_FNS.has(ic.functionName().toString())) return false;
    return ownAuthIs(op, (f) => f.switch().name === 'sorobanAuthorizedFunctionTypeContractFn' && f.contractFn().toXDR('hex') === ic.toXDR('hex'));
  };

  const walletDeploy = (op: Op) => {
    const func = op.func as xdr.HostFunction | undefined;
    if (op.source !== undefined || !func || func.switch().name !== 'hostFunctionTypeCreateContractV2') return false;
    const create = func.createContractV2();
    const exec = create.executable();
    if (exec.switch().name !== 'contractExecutableWasm' || Buffer.from(exec.wasmHash()).toString('hex') !== TESTNET.accountWasmHash) return false;
    const pre = create.contractIdPreimage();
    if (pre.switch().name !== 'contractIdPreimageFromAddress' || Address.fromScAddress(pre.fromAddress().address()).toString() !== sponsor) return false;
    return ownAuthIs(
      op,
      (f) => f.switch().name === 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn' && f.createContractV2HostFn().toXDR('hex') === create.toXDR('hex'),
    );
  };

  return {
    check(txXdr, networkPassphrase) {
      if (networkPassphrase !== TESTNET.passphrase) throw new Error('chain: the sponsor signs testnet transactions only');
      let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
      try {
        parsed = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
      } catch {
        throw refuse();
      }
      if ('innerTransaction' in parsed) {
        // The sponsor pays for an agent's seal or close and nothing else: its fee only, never its own sequence or a source op.
        const fb = parsed as FeeBumpTransaction;
        if (fb.feeSource !== sponsor) throw refuse();
        const seal = sealShape(fb.innerTransaction);
        if (seal) {
          if (seal.agent === sponsor) throw refuse();
          if (BigInt(fb.fee) > SEAL_MAX_FEE_STROOPS) throw new Error(`chain: fee ${fb.fee} above cap ${SEAL_MAX_FEE_STROOPS}`);
          return { tx: fb, kind: 'seal' };
        }
        const close = closeShape(fb.innerTransaction);
        if (!close || close.agent === sponsor) throw refuse();
        if (BigInt(fb.fee) > CLOSE_MAX_FEE_STROOPS) throw new Error(`chain: fee ${fb.fee} above cap ${CLOSE_MAX_FEE_STROOPS}`);
        return { tx: fb, kind: 'close' };
      }
      const tx = parsed as Transaction;
      if (tx.source !== sponsor) throw new Error('chain: the sponsor signs only transactions it sources');
      const ops = tx.operations as unknown as Op[];
      let kind: SponsorTxKind;
      if (ops.length === 1 && ops[0]!.type === 'invokeHostFunction') {
        if (registryCall(ops[0]!)) kind = 'registry';
        else if (walletDeploy(ops[0]!)) kind = 'wallet';
        else throw refuse();
      } else if (birth(ops)) kind = 'birth';
      else if (reserveShape(tx)) kind = 'reserve';
      else {
        const credit = creditShape(tx);
        if (!credit) throw refuse();
        return { tx, kind: 'credit', creditTo: credit.agent };
      }
      if (BigInt(tx.fee) > maxFee) throw new Error(`chain: fee ${tx.fee} above cap ${maxFee}`);
      return { tx, kind };
    },
  };
}

/** A signer over a key in this process, behind the policy. The vault's, or the api's own in tests and local dev. */
export function policySponsor(kp: Keypair, maxFeeStroops?: bigint): StellarSigner & { policy: SponsorPolicy } {
  const policy = createSponsorPolicy({ sponsorPublicKey: kp.publicKey(), maxFeeStroops });
  return {
    publicKey: kp.publicKey(),
    policy,
    async signTransaction(txXdr, passphrase) {
      const { tx } = policy.check(txXdr, passphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

/** Reads the sponsor key from the environment (the vault's, or the api's before the move). */
export function sponsorFromEnv(env: Record<string, string | undefined>, maxFeeStroops?: bigint) {
  const secret = env.SPONSOR_SECRET;
  if (!secret) throw new Error('chain: SPONSOR_SECRET is not set');
  let kp: Keypair;
  try {
    kp = Keypair.fromSecret(secret);
  } catch {
    throw new Error('chain: SPONSOR_SECRET is not a valid Stellar secret');
  }
  return policySponsor(kp, maxFeeStroops);
}

/** The sponsor key when this process holds one (the vault, once it does), else undefined. */
export function optionalSponsorFromEnv(env: Record<string, string | undefined>) {
  return env.SPONSOR_SECRET ? sponsorFromEnv(env) : undefined;
}
