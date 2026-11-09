/**
 * The sealing transaction, built and checked in one place (the worker builds it, the vault and the sponsor policy check
 * it). The agent's own account is the source and the only signer of the inner transaction:
 *
 *   inner     source = agent, one bump_sequence(bump_to 0) with no op source, MEMO_HASH = sha256(seal document)
 *   fee-bump  fee source = the platform sponsor, which pays; the agent spends no XLM. A self-paying agent (FEE_MODEL=agent)
 *             sends the inner tx as it is and pays its SEAL_INNER_FEE itself.
 *
 * bump_sequence to 0 never moves a sequence forward: the op is a no-op, needs no reserve and can move no funds. The
 * memo is the commitment. Each agent's sequence is its own, so seals need no global lock.
 */
import { Memo, Operation, TransactionBuilder, type Account, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';

/** The inner tx's fee bid (stroops). Under a fee-bump nobody pays it; a self-paying agent pays it sent alone. */
export const SEAL_INNER_FEE = '100';
/** The fee-bump's base fee (stroops per op); a 1-op inner tx bids twice this. */
export const SEAL_BASE_FEE = '100';
/** The most a seal's fee-bump may bid in total (stroops): 0.0001 XLM, room for 5x surge pricing. */
export const SEAL_MAX_FEE_STROOPS = 1_000n;
/** How long a built seal tx stays valid. */
export const SEAL_TIMEOUT_S = 120;

export function buildSealTx(account: Account, digestHex: string, passphrase: string): Transaction {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error('seal: bad digest');
  return new TransactionBuilder(account, { fee: SEAL_INNER_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.bumpSequence({ bumpTo: '0' }))
    .addMemo(Memo.hash(digestHex))
    .setTimeout(SEAL_TIMEOUT_S)
    .build();
}

export function feeBumpSeal(inner: Transaction, sponsor: string, passphrase: string): FeeBumpTransaction {
  return TransactionBuilder.buildFeeBumpTransaction(sponsor, SEAL_BASE_FEE, inner, passphrase);
}

/** The inner seal's source and memo digest when `tx` has exactly the seal shape; null otherwise. */
export function sealShape(tx: Transaction): { agent: string; digest: string; maxTime: number } | null {
  const ops = tx.operations;
  if (ops.length !== 1) return null;
  const op = ops[0]!;
  if (op.type !== 'bumpSequence' || op.source !== undefined || String(op.bumpTo) !== '0') return null;
  if (tx.memo.type !== 'hash' || !Buffer.isBuffer(tx.memo.value)) return null;
  if (BigInt(tx.fee) > SEAL_MAX_FEE_STROOPS) return null;
  // Always time-bounded; the vault also checks the bound against its clock (sealExpiresSoon).
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!(maxTime > 0)) return null;
  return { agent: tx.source, digest: (tx.memo.value as Buffer).toString('hex'), maxTime };
}
