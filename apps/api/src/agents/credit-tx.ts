/**
 * Testnet credit (Kerem, 2026-11-01, "Ev satıcıları + dışarıdan alım"): the platform sponsor gives a hosted agent a
 * little testnet USDC so its hire_agent can actually pay another agent. Built and checked in one place (the credit
 * worker builds it, the sponsor policy and the vault check it):
 *
 *   credit   path_payment_strict_receive(sponsor → agent, XLM → exactly CREDIT_UNITS of USDC), sourced and paid by the
 *            sponsor. The sponsor spends its own testnet XLM on the DEX; nothing of the agent's is touched, so the agent
 *            signs nothing.
 *
 * Testnet only (the sponsor policy refuses any other passphrase). The credit is an operator top-up: AgentKarma and our
 * own counts exclude it. Only what the agent then pays to a seller is a payment.
 */
import { Asset, Operation, TransactionBuilder, type Account, type Transaction } from '@stellar/stellar-sdk';
import { TESTNET } from '../owner-client/testnet.js';

/** What one credit gives (7 decimals): 1 USDC, enough for twenty to a hundred small hires. */
export const CREDIT_UNITS = 10_000_000n;
export const CREDIT_AMOUNT = '1.0000000';
/** The most XLM one credit may spend (stroops): 20 XLM, about eight times today's testnet price of 1 USDC. */
export const CREDIT_MAX_SEND_STROOPS = 200_000_000n;
/** The most a credit tx may bid in total (stroops). One classic op costs a few hundred. */
export const CREDIT_MAX_FEE_STROOPS = 100_000n;
const CREDIT_FEE = 1_000;
export const CREDIT_TIMEOUT_S = 120;

const [USDC_CODE, USDC_ISSUER] = TESTNET.usdc.split(':') as [string, string];
const USDC = new Asset(USDC_CODE, USDC_ISSUER);

const units = (s: string) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
};
const amount = (u: bigint) => `${u / 10_000_000n}.${(u % 10_000_000n).toString().padStart(7, '0')}`;

/** `path`: the intermediate assets Horizon's strict-receive quote named (none for the direct XLM/USDC book). */
export function buildCreditTx(sponsor: Account, agent: string, sendMaxStroops: bigint, path: Asset[], passphrase: string): Transaction {
  if (sendMaxStroops <= 0n || sendMaxStroops > CREDIT_MAX_SEND_STROOPS) throw new Error('credit: bad sendMax');
  if (agent === sponsor.accountId()) throw new Error('credit: the sponsor cannot credit itself');
  return new TransactionBuilder(sponsor, { fee: String(CREDIT_FEE), networkPassphrase: passphrase })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: amount(sendMaxStroops),
        destination: agent,
        destAsset: USDC,
        destAmount: CREDIT_AMOUNT,
        path,
      }),
    )
    .setTimeout(CREDIT_TIMEOUT_S)
    .build();
}

type Op = { type: string; source?: string; [k: string]: unknown };
const G = /^G[A-Z2-7]{55}$/;

export interface CreditShape {
  sponsor: string;
  agent: string;
  sendMaxStroops: bigint;
}

/** The credit shape of `tx` (sourced by the sponsor, one op, exactly CREDIT_UNITS of USDC to one other account), or null. */
export function creditShape(tx: Transaction): CreditShape | null {
  if (BigInt(tx.fee) > CREDIT_MAX_FEE_STROOPS) return null;
  if (!(Number(tx.timeBounds?.maxTime ?? 0) > 0)) return null;
  if (tx.memo.type !== 'none') return null;
  const ops = tx.operations as unknown as Op[];
  if (ops.length !== 1) return null;
  const p = ops[0]!;
  const sponsor = tx.source;
  if (p.type !== 'pathPaymentStrictReceive' || p.source !== undefined) return null;
  const agent = String(p.destination ?? '');
  if (!G.test(agent) || agent === sponsor) return null;
  if (!(p.sendAsset instanceof Asset) || !p.sendAsset.isNative()) return null;
  if (!(p.destAsset instanceof Asset) || !p.destAsset.equals(USDC) || units(String(p.destAmount)) !== CREDIT_UNITS) return null;
  if (!Array.isArray(p.path) || p.path.length > 5) return null;
  const sendMaxStroops = units(String(p.sendMax));
  if (sendMaxStroops <= 0n || sendMaxStroops > CREDIT_MAX_SEND_STROOPS) return null;
  return { sponsor, agent, sendMaxStroops };
}
