/**
 * An agent's Stellar reserves changing hands, built and checked in one place (the reserve worker and the closer build
 * these, the vault and the sponsor policy check them). Both are sourced by the platform sponsor, which pays their fee;
 * the agent signs for its own ops:
 *
 *   handover   path_payment_strict_receive(agent → agent, USDC → exactly RESERVE_XLM + float + repay), then revoke_sponsorship
 *              of the agent's account and its USDC trustline, then (repay > 0) payment(agent → sponsor, repay XLM): the agent
 *              now holds its own reserves and a float for its own fees, bought with its own USDC, and has paid back the fees
 *              the sponsor fronted at its birth. Atomic: a swap that cannot fill leaves the sponsorship as it was.
 *              Under FEE_MODEL=sponsor the float and the repay are 0 (the original 3-op shape).
 *   topup      path_payment_strict_receive(agent → agent, USDC → exactly FLOAT_XLM): a self-paying agent whose fee float
 *              ran low buys another, with its own USDC.
 *   responsor  begin_sponsoring(agent), revoke_sponsorship of both entries by the agent, end_sponsoring: the sponsor takes
 *              the reserves back, so the agent's RESERVE_XLM becomes spendable and the closer can sweep it to its owner.
 *
 * Proven on testnet 2026-10-31 (fresh accounts): handover ccedae22…, responsor ba78e41f…. The self-paying shapes on
 * 2026-11-01 (fresh accounts): handover with float and repay 259e13ee…, the agent's own unbumped seal 1276eee7…, topup
 * 693bed7e…; a seal with no spendable XLM fails tx_insufficient_balance.
 */
import { Asset, Operation, TransactionBuilder, type Account, type Transaction } from '@stellar/stellar-sdk';
import { TESTNET } from '../owner-client/testnet.js';

/** An agent's own minimum balance: two base reserves for the account, one for the USDC trustline (0.5 XLM each). */
export const RESERVE_XLM = '1.5000000';
export const RESERVE_STROOPS = 15_000_000n;
/** The most USDC a handover may spend on its reserves (7 decimals): 1 USDC, about four times today's price. */
export const RESERVE_MAX_SEND_UNITS = 10_000_000n;
/** The XLM a self-paying agent keeps spendable for its own fees: about a month of check seals at 288 a day. */
export const FLOAT_XLM = '1.0000000';
export const FLOAT_STROOPS = 10_000_000n;
/**
 * The most a handover may pay the sponsor back for the fees it fronted at the agent's birth (stroops): 1 XLM. Testnet
 * births cost about 0.3 XLM. The amount comes from a row the api writes, so this cap is what a compromised api could
 * overcharge an agent (to the platform's own sponsor, nobody else). Pubnet register_with_uri has simulated at 27.29 XLM:
 * before pubnet, the vault must derive the amount from the birth txs itself rather than raise this.
 */
export const MAX_REPAY_STROOPS = 10_000_000n;
/** The most USDC a swap for `destStroops` of XLM may spend: the handover's price cap (1 USDC per 1.5 XLM), scaled. */
export const maxSendFor = (destStroops: bigint) => (RESERVE_MAX_SEND_UNITS * destStroops) / RESERVE_STROOPS;
/** The most a reserve tx may bid in total (stroops): 0.01 XLM. Three or four classic ops cost a few hundred. */
export const RESERVE_MAX_FEE_STROOPS = 100_000n;
const RESERVE_FEE_PER_OP = 1_000;
/** How long a built reserve tx stays valid. */
export const RESERVE_TIMEOUT_S = 120;

const [USDC_CODE, USDC_ISSUER] = TESTNET.usdc.split(':') as [string, string];
const USDC = new Asset(USDC_CODE, USDC_ISSUER);

export type ReserveShape =
  | { kind: 'handover'; sponsor: string; agent: string; sendMax: bigint; maxTime: number; floatStroops: bigint; repayStroops: bigint }
  | { kind: 'topup'; sponsor: string; agent: string; sendMax: bigint; maxTime: number }
  | { kind: 'responsor'; sponsor: string; agent: string; maxTime: number };

const units = (s: string) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
};
/** 7-decimal amounts (USDC units and XLM stroops alike) as a Stellar amount string. */
export const unitsToAmount = (u: bigint) => `${u / 10_000_000n}.${(u % 10_000_000n).toString().padStart(7, '0')}`;

/** The agent's own USDC → exactly `destStroops` of XLM, into its own account. `path`: the hops Horizon's quote named (none for a direct book). */
const swapOp = (agent: string, sendMax: bigint, destStroops: bigint, path: Asset[]) =>
  Operation.pathPaymentStrictReceive({
    source: agent,
    sendAsset: USDC,
    sendMax: unitsToAmount(sendMax),
    destination: agent,
    destAsset: Asset.native(),
    destAmount: unitsToAmount(destStroops),
    path,
  });

/** `o.float` / `o.repay`: the fee float the agent keeps and the fronted fees it pays the sponsor back (FEE_MODEL=agent). */
export function buildHandoverTx(
  sponsor: Account,
  agent: string,
  sendMax: bigint,
  path: Asset[],
  passphrase: string,
  o: { floatStroops?: bigint; repayStroops?: bigint } = {},
): Transaction {
  const float = o.floatStroops ?? 0n;
  const repay = o.repayStroops ?? 0n;
  if (float !== 0n && float !== FLOAT_STROOPS) throw new Error('reserve: bad float');
  if (repay < 0n || repay > MAX_REPAY_STROOPS) throw new Error('reserve: bad repay');
  const dest = RESERVE_STROOPS + float + repay;
  if (sendMax <= 0n || sendMax > maxSendFor(dest)) throw new Error('reserve: bad sendMax');
  const b = new TransactionBuilder(sponsor, { fee: String(RESERVE_FEE_PER_OP), networkPassphrase: passphrase })
    .addOperation(swapOp(agent, sendMax, dest, path))
    .addOperation(Operation.revokeAccountSponsorship({ account: agent }))
    .addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC }));
  if (repay > 0n) b.addOperation(Operation.payment({ source: agent, destination: sponsor.accountId(), asset: Asset.native(), amount: unitsToAmount(repay) }));
  return b.setTimeout(RESERVE_TIMEOUT_S).build();
}

export function buildTopupTx(sponsor: Account, agent: string, sendMax: bigint, path: Asset[], passphrase: string): Transaction {
  if (sendMax <= 0n || sendMax > maxSendFor(FLOAT_STROOPS)) throw new Error('reserve: bad sendMax');
  return new TransactionBuilder(sponsor, { fee: String(RESERVE_FEE_PER_OP), networkPassphrase: passphrase })
    .addOperation(swapOp(agent, sendMax, FLOAT_STROOPS, path))
    .setTimeout(RESERVE_TIMEOUT_S)
    .build();
}

export function buildResponsorTx(sponsor: Account, agent: string, passphrase: string): Transaction {
  return new TransactionBuilder(sponsor, { fee: String(RESERVE_FEE_PER_OP), networkPassphrase: passphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent }))
    .addOperation(Operation.revokeAccountSponsorship({ account: agent, source: agent }))
    .addOperation(Operation.revokeTrustlineSponsorship({ account: agent, asset: USDC, source: agent }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: agent }))
    .setTimeout(RESERVE_TIMEOUT_S)
    .build();
}

type Op = { type: string; source?: string; [k: string]: unknown };
const isUsdc = (a: unknown) => a instanceof Asset && a.equals(USDC);
const G = /^G[A-Z2-7]{55}$/;

/** The reserve shape of `tx` (sourced by its sponsor, about one agent), or null for anything else. */
export function reserveShape(tx: Transaction): ReserveShape | null {
  if (BigInt(tx.fee) > RESERVE_MAX_FEE_STROOPS) return null;
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!(maxTime > 0)) return null;
  if (tx.memo.type !== 'none') return null;
  const sponsor = tx.source;
  const ops = tx.operations as unknown as Op[];
  /** The agent's swap of its own USDC into `dest` stroops of XLM, into its own account; null when `p` is anything else. */
  const swap = (p: Op): { agent: string; sendMax: bigint; dest: bigint } | null => {
    const agent = String(p.source ?? '');
    if (!G.test(agent) || agent === sponsor) return null;
    if (p.type !== 'pathPaymentStrictReceive' || p.destination !== agent || !isUsdc(p.sendAsset)) return null;
    if (!(p.destAsset instanceof Asset) || !p.destAsset.isNative()) return null;
    // The path may route through other books (Horizon picks the cheapest); it cannot change what is paid or received.
    if (!Array.isArray(p.path) || p.path.length > 5) return null;
    const dest = units(String(p.destAmount));
    const sendMax = units(String(p.sendMax));
    if (sendMax <= 0n || sendMax > maxSendFor(dest)) return null;
    return { agent, sendMax, dest };
  };
  if (ops.length === 1) {
    const s = swap(ops[0]!);
    if (!s || s.dest !== FLOAT_STROOPS) return null;
    return { kind: 'topup', sponsor, agent: s.agent, sendMax: s.sendMax, maxTime };
  }
  if ((ops.length === 3 || ops.length === 4) && ops[0]!.type === 'pathPaymentStrictReceive') {
    const [p, a, t, r] = ops as [Op, Op, Op, Op | undefined];
    const s = swap(p);
    if (!s) return null;
    const agent = s.agent;
    if (a.type !== 'revokeAccountSponsorship' || a.account !== agent || a.source !== undefined) return null;
    if (t.type !== 'revokeTrustlineSponsorship' || t.account !== agent || !isUsdc(t.asset) || t.source !== undefined) return null;
    // The repay goes to the sponsor that sources the tx, in XLM, from the agent: nobody else can be paid here.
    let repay = 0n;
    if (r) {
      if (r.type !== 'payment' || r.source !== agent || r.destination !== sponsor || !(r.asset instanceof Asset) || !r.asset.isNative()) return null;
      repay = units(String(r.amount));
      if (repay <= 0n || repay > MAX_REPAY_STROOPS) return null;
    }
    const float = s.dest - RESERVE_STROOPS - repay;
    if (float !== 0n && float !== FLOAT_STROOPS) return null;
    return { kind: 'handover', sponsor, agent, sendMax: s.sendMax, maxTime, floatStroops: float, repayStroops: repay };
  }
  if (ops.length === 4) {
    const [b, a, t, e] = ops as [Op, Op, Op, Op];
    const agent = String(b.sponsoredId ?? '');
    if (b.type !== 'beginSponsoringFutureReserves' || !G.test(agent) || agent === sponsor || b.source !== undefined) return null;
    if (a.type !== 'revokeAccountSponsorship' || a.account !== agent || a.source !== agent) return null;
    if (t.type !== 'revokeTrustlineSponsorship' || t.account !== agent || !isUsdc(t.asset) || t.source !== agent) return null;
    if (e.type !== 'endSponsoringFutureReserves' || e.source !== agent) return null;
    return { kind: 'responsor', sponsor, agent, maxTime };
  }
  return null;
}
