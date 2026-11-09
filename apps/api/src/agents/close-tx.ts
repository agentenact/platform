/**
 * Closing a deleted agent's Stellar wallet, built and checked in one place (the closer builds these, the vault and the
 * sponsor policy check them). The agent's own account is the source and the only signer of each inner transaction; the
 * platform sponsor fee-bumps it, so the agent spends no XLM:
 *
 *   sweep  one SAC transfer(agent → to, amount) of USDC or XLM, authorized by the source account alone
 *   merge  change_trust(USDC, limit 0) then account_merge(→ destination): the trustline goes, the account goes, and
 *          the reserves the sponsor paid at birth come back to it
 *
 * Where the money may go is the vault's check, not this file's: a sweep only to the agent's owner, a merge only to the
 * owner (a G account) or else the sponsor. Here only the shape is pinned, so a shape can move no funds by accident.
 */
import {
  Address,
  Asset,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Account,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import { TESTNET } from '../owner-client/testnet.js';

/** The inner tx's fee bid per op (stroops). Paid by nobody: a fee-bump's fee source pays the whole fee. */
export const CLOSE_INNER_FEE = '100';
/** The fee-bump's base fee (stroops per op): above the inner rate, room for surge pricing. */
export const CLOSE_BASE_FEE = '1000';
/** The most a close tx, inner or fee-bump, may bid in total (stroops): 1 XLM. A SAC transfer's resource fee is about 10⁵. */
export const CLOSE_MAX_FEE_STROOPS = 10_000_000n;
/** How long a built close tx stays valid. */
export const CLOSE_TIMEOUT_S = 120;

const [USDC_CODE, USDC_ISSUER] = TESTNET.usdc.split(':') as [string, string];
export const USDC_ASSET = new Asset(USDC_CODE, USDC_ISSUER);
/** The SACs a sweep may call: testnet USDC and native XLM. */
export const SWEEP_CONTRACTS = { usdc: TESTNET.usdcSac, xlm: Asset.native().contractId(TESTNET.passphrase) } as const;
export type SweepAsset = keyof typeof SWEEP_CONTRACTS;

export type CloseShape =
  | { kind: 'sweep'; agent: string; asset: SweepAsset; to: string; amount: bigint; maxTime: number }
  | { kind: 'merge'; agent: string; destination: string; maxTime: number };

/** The unprepared sweep: simulate and assemble it (soroban.prepare) before it is signed. */
export function buildSweepTx(account: Account, asset: SweepAsset, to: string, amount: bigint, passphrase: string): Transaction {
  if (amount <= 0n) throw new Error('close: bad amount');
  return new TransactionBuilder(account, { fee: CLOSE_INNER_FEE, networkPassphrase: passphrase })
    .addOperation(
      new Contract(SWEEP_CONTRACTS[asset]).call('transfer', new Address(account.accountId()).toScVal(), new Address(to).toScVal(), nativeToScVal(amount, { type: 'i128' })),
    )
    .setTimeout(CLOSE_TIMEOUT_S)
    .build();
}

export function buildMergeTx(account: Account, destination: string, passphrase: string): Transaction {
  return new TransactionBuilder(account, { fee: String(Number(CLOSE_INNER_FEE) * 2), networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET, limit: '0' }))
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(CLOSE_TIMEOUT_S)
    .build();
}

export function feeBumpClose(inner: Transaction, sponsor: string, passphrase: string): FeeBumpTransaction {
  return TransactionBuilder.buildFeeBumpTransaction(sponsor, CLOSE_BASE_FEE, inner, passphrase);
}

type Op = { type: string; source?: string; [k: string]: unknown };

/** The close shape of `tx` (a sweep or a merge, from the agent's own account), or null for anything else. */
export function closeShape(tx: Transaction): CloseShape | null {
  if (BigInt(tx.fee) > CLOSE_MAX_FEE_STROOPS) return null;
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!(maxTime > 0)) return null;
  if (tx.memo.type !== 'none') return null;
  const ops = tx.operations as unknown as Op[];
  if (ops.some((op) => op.source !== undefined)) return null;
  if (ops.length === 2 && ops[0]!.type === 'changeTrust' && ops[1]!.type === 'accountMerge') {
    const line = ops[0]!.line as Asset | undefined;
    if (!(line instanceof Asset) || !line.equals(USDC_ASSET) || Number(ops[0]!.limit) !== 0) return null;
    const destination = String(ops[1]!.destination);
    if (!/^G[A-Z2-7]{55}$/.test(destination) || destination === tx.source) return null;
    return { kind: 'merge', agent: tx.source, destination, maxTime };
  }
  if (ops.length === 1 && ops[0]!.type === 'invokeHostFunction') return sweepShape(tx, ops[0]!, maxTime);
  return null;
}

function sweepShape(tx: Transaction, op: Op, maxTime: number): CloseShape | null {
  try {
    const func = op.func as xdr.HostFunction | undefined;
    if (!func || func.switch().name !== 'hostFunctionTypeInvokeContract') return null;
    const ic = func.invokeContract();
    const contract = Address.fromScAddress(ic.contractAddress()).toString();
    const asset = (Object.keys(SWEEP_CONTRACTS) as SweepAsset[]).find((k) => SWEEP_CONTRACTS[k] === contract);
    if (!asset || ic.functionName().toString() !== 'transfer') return null;
    const args = ic.args();
    if (args.length !== 3 || args[2]!.switch().name !== 'scvI128') return null;
    const from = Address.fromScVal(args[0]!).toString();
    const to = Address.fromScVal(args[1]!).toString();
    const amount = BigInt(scValToNative(args[2]!) as bigint);
    if (from !== tx.source || to === from || amount <= 0n) return null;
    // Only the source account's own authorization, for exactly this call and nothing under it.
    const auth = (op.auth as xdr.SorobanAuthorizationEntry[] | undefined) ?? [];
    const ok = auth.every(
      (e) =>
        e.credentials().switch().name === 'sorobanCredentialsSourceAccount' &&
        e.rootInvocation().subInvocations().length === 0 &&
        e.rootInvocation().function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn' &&
        e.rootInvocation().function().contractFn().toXDR('hex') === ic.toXDR('hex'),
    );
    if (!ok) return null;
    return { kind: 'sweep', agent: tx.source, asset, to, amount, maxTime };
  } catch {
    return null;
  }
}
