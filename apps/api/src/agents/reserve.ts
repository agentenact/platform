/**
 * Who pays an agent's Stellar reserves and fees. Every agent is born sponsored by the platform: its account and USDC
 * trustline lock 1.5 XLM of the sponsor's, and the sponsor pays its birth, register and bind fees. What happens next is
 * FEE_MODEL (config.ts):
 *
 *   agent    (Kerem, 2026-11-01, "Her şey agent cüzdanından", the default) every agent is 'due' and paused until its first
 *            USDC. Then one atomic tx (reserve-tx.ts handover) swaps its own USDC into 1.5 XLM of reserves, FLOAT_XLM for its
 *            own fees and the fees the sponsor fronted, which it pays back in the same tx; the sponsor revokes its
 *            sponsorship and the agent is resumed. From then on it pays its own fees (pays_own_fees): check seals go out
 *            unbumped, and when its float runs low the seal worker asks for a topup, bought here with its own USDC.
 *   sponsor  (Kerem, 2026-10-31, "Rezerv devri (A)") the platform keeps sponsoring one agent per account (reserve_state
 *            'free') and pays every fee; any other agent is 'due' and, once funded, swaps its own USDC into exactly 1.5 XLM.
 *
 * The platform keeps nothing but what it fronted, and no price is fixed anywhere: the agent pays in XLM, at the market.
 *
 * Deleting a self-paid agent returns its reserves to its owner: a G owner gets them through the account merge; a C owner
 * (a passkey wallet, which a merge cannot reach) gets them through `responsor` (the sponsor takes the reserves back, the
 * agent's 1.5 XLM becomes spendable) and the closer's XLM sweep.
 *
 * The leader's `tick` claims due agents like the closer does. A wait (unfunded, too little USDC, no account yet) costs
 * no attempt; a failure retries with a growing wait and never gives up (the agent stays 'due'). Every run re-reads the
 * chain first, so a handover whose answer was lost is found sponsored-by-nobody and recorded, never sent twice.
 */
import { Asset, type Account, type Transaction } from '@stellar/stellar-sdk';
import type { Db } from '../db/index.js';
import { TESTNET } from '../owner-client/testnet.js';
import { retryDelayS } from './close.js';
import type { FeeModel } from '../config.js';
import { skipMissedSlots } from './index.js';
import { buildHandoverTx, buildResponsorTx, buildTopupTx, FLOAT_STROOPS, maxSendFor, MAX_REPAY_STROOPS, RESERVE_STROOPS, unitsToAmount } from './reserve-tx.js';

/** The USDC an extra agent must hold before it buys its reserves (7 decimals): 0.50 USDC, so a tiny top-up is not eaten. */
export const HANDOVER_MIN_UNITS = 5_000_000n;
/** Room above the quote for the book moving between the quote and the ledger: 2 %. */
export const SLIPPAGE_PERCENT = 2n;
/** A self-paying agent with less spendable XLM than this buys another float. 0.1 XLM: about ten days of seals. */
export const FLOAT_LOW_STROOPS = 1_000_000n;
/** How soon an unfunded due agent is looked at again. */
export const WAIT_S = 120;
/** A claimed agent is hidden from other workers this long. */
const CLAIM_LEASE_S = 300;
const BATCH = 5;

export interface ReserveAccount {
  /** Whether the account entry still has a sponsor (Horizon `sponsor`). */
  sponsored: boolean;
  /** USDC held, in 7-decimal units. */
  usdc: bigint;
  /** XLM above the account's own minimum balance, in stroops. */
  xlm: bigint;
}

export interface ReserveChain {
  sponsorPublicKey: string;
  /** null when the account does not exist. Throws when Horizon cannot say. */
  account(id: string): Promise<ReserveAccount | null>;
  /** The cheapest USDC route to exactly `destStroops` of XLM right now, or null when the DEX has none. */
  quote(destStroops: bigint): Promise<{ sendUnits: bigint; path: Asset[] } | null>;
  /** What a landed tx cost its fee payer (Horizon fee_charged), in stroops. Throws when Horizon cannot say. */
  feeCharged(hash: string): Promise<bigint>;
  sponsorAccount(): Promise<Account>;
  signSponsor(txXdr: string, passphrase: string): Promise<string>;
  submit(txXdr: string): Promise<{ hash: string }>;
  withSponsorLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ReserveKeys {
  publicKey(agentId: string): Promise<string | null>;
  signReserve(agentId: string, txXdr: string, passphrase: string): Promise<string>;
}

export interface Reserves {
  /** The leader's pass over due agents and self-paying agents whose float ran low. */
  tick(): Promise<{ handed: number; waiting: number; failed: number; topped: number }>;
  /** For the closer: the sponsor takes a deleted, self-paid agent's reserves back. Returns the tx hash. */
  responsor(agentId: string, address: string): Promise<string>;
}

const fail = (code: string) => Object.assign(new Error(`reserve: ${code}`), { reserveCode: code });
const errorCode = (e: unknown): string => {
  const own = (e as { reserveCode?: unknown } | null)?.reserveCode;
  if (typeof own === 'string') return own;
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string') return `vault_${reason}`.slice(0, 60);
  const m = e instanceof Error ? e.message : '';
  if (/op_too_few_offers|op_over_source_max/.test(m)) return 'swap_failed';
  if (/tx_bad_seq/.test(m)) return 'bad_seq';
  if (/Horizon submit failed/.test(m)) return `horizon_${/failed: (\d{3})/.exec(m)?.[1] ?? 'error'}`;
  if (/sponsor refuses|above cap/.test(m)) return 'sponsor_refused';
  if (/chain_busy/.test(m)) return 'chain_busy';
  return 'error';
};

export function createReserves(d: {
  sql: Db;
  chain: ReserveChain;
  keys: ReserveKeys;
  /** Absent: 'sponsor', the model the worker was written for. */
  feeModel?: FeeModel;
  killed?: () => boolean;
  log: (e: Record<string, unknown>) => void;
}): Reserves {
  const { sql, chain, keys, log } = d;
  const selfPaying = d.feeModel === 'agent';
  const passphrase = TESTNET.passphrase;

  /** Built on the sponsor's live sequence, signed by the agent (the vault) and the sponsor, sent: under the sponsor lock. */
  async function send(agentId: string, address: string, build: (sponsor: Account) => Transaction): Promise<string> {
    return chain.withSponsorLock(async () => {
      const tx = build(await chain.sponsorAccount());
      tx.addSignature(address, await keys.signReserve(agentId, tx.toXDR(), passphrase));
      return (await chain.submit(await chain.signSponsor(tx.toXDR(), passphrase))).hash;
    });
  }

  type Outcome = { done: 'handed'; tx: string | null; units: bigint | null; selfPaying: boolean } | { done: 'topped'; tx: string | null } | { done: 'wait' };

  /** The cheapest swap into `dest` stroops with SLIPPAGE_PERCENT of room, or why not; null when the agent holds too little. */
  async function priced(dest: bigint, usdc: bigint): Promise<{ sendMax: bigint; sendUnits: bigint; path: Asset[] } | null> {
    const q = await chain.quote(dest);
    if (!q) throw fail('no_path');
    const sendMax = (q.sendUnits * (100n + SLIPPAGE_PERCENT)) / 100n + 1n;
    if (sendMax > maxSendFor(dest)) throw fail('price_above_cap');
    return usdc < sendMax ? null : { sendMax, sendUnits: q.sendUnits, path: q.path };
  }

  /**
   * What the sponsor fronted for this agent's birth: the fees of the account, register and bind txs of the attempt that
   * made it (resumed attempts carry the hashes they continued). Failed attempts before it are the platform's to carry.
   */
  async function fronted(agentId: string): Promise<bigint> {
    const [r] = (await sql`select provision_state->'attempts'->-1->'txs' as txs from app.agents where id = ${agentId}`) as { txs: Record<string, string> | null }[];
    let total = 0n;
    for (const hash of new Set(Object.values(r?.txs ?? {}))) total += await chain.feeCharged(hash);
    if (total > MAX_REPAY_STROOPS) throw fail('repay_above_cap');
    return total;
  }

  async function handover(agentId: string, address: string, acc: ReserveAccount): Promise<Outcome> {
    if (acc.usdc < HANDOVER_MIN_UNITS) return { done: 'wait' };
    const repay = selfPaying ? await fronted(agentId) : 0n;
    const float = selfPaying ? FLOAT_STROOPS : 0n;
    const p = await priced(RESERVE_STROOPS + float + repay, acc.usdc);
    if (!p) return { done: 'wait' };
    // The vault signs a repay of exactly what the row says: written first, from the chain, never from the request.
    await sql`update app.agents set reserve_repay_stroops = ${repay.toString()} where id = ${agentId}`;
    const tx = await send(agentId, address, (s) => buildHandoverTx(s, address, p.sendMax, p.path, passphrase, { floatStroops: float, repayStroops: repay }));
    return { done: 'handed', tx, units: p.sendUnits, selfPaying };
  }

  async function topup(agentId: string, address: string, acc: ReserveAccount): Promise<Outcome> {
    if (acc.xlm >= FLOAT_LOW_STROOPS) return { done: 'topped', tx: null };
    const p = await priced(FLOAT_STROOPS, acc.usdc);
    if (!p) return { done: 'wait' };
    return { done: 'topped', tx: await send(agentId, address, (s) => buildTopupTx(s, address, p.sendMax, p.path, passphrase)) };
  }

  async function run(c: Claimed): Promise<Outcome> {
    const address = await keys.publicKey(c.id);
    if (!address) return { done: 'wait' };
    const acc = await chain.account(address);
    if (!acc) return { done: 'wait' };
    if (c.reserve_state === 'self_paid') return topup(c.id, address, acc);
    // Nobody sponsors it any more: an earlier handover landed (its answer lost), or its reserves came from elsewhere. Its
    // fees are its own only if it holds a float: a lost handover answer under FEE_MODEL=agent did buy one.
    if (!acc.sponsored) return { done: 'handed', tx: null, units: null, selfPaying: selfPaying && acc.xlm >= FLOAT_LOW_STROOPS };
    return handover(c.id, address, acc);
  }

  type Claimed = { id: string; attempts: number; reserve_state: 'due' | 'self_paid' };
  /** Due agents, and self-paying ones the seal worker flagged (reserve_next_at set) because their float ran low. */
  async function claim(): Promise<Claimed[]> {
    return (await sql`update app.agents a set reserve_next_at = now() + ${CLAIM_LEASE_S} * interval '1 second'
                      from (select id from app.agents
                            where (reserve_state = 'due' or (pays_own_fees and reserve_state = 'self_paid' and reserve_next_at is not null))
                              and status in ('active', 'paused') and coalesce(reserve_next_at, now()) <= now()
                            order by reserve_next_at nulls first limit ${BATCH} for update skip locked) due
                      where a.id = due.id
                      returning a.id, a.reserve_attempts as attempts, a.reserve_state`) as Claimed[];
  }

  return {
    async tick() {
      const n = { handed: 0, waiting: 0, failed: 0, topped: 0 };
      if (d.killed?.()) return n;
      for (const c of await claim()) {
        try {
          const r = await run(c);
          if (r.done === 'wait') {
            await sql`update app.agents set reserve_next_at = now() + ${WAIT_S} * interval '1 second' where id = ${c.id}`;
            n.waiting++;
            continue;
          }
          if (r.done === 'topped') {
            await sql`update app.agents set reserve_next_at = null, reserve_attempts = 0, reserve_error = null where id = ${c.id}`;
            if (r.tx) log({ event: 'agent_float_topped', agent: c.id, tx: r.tx });
            n.topped++;
            continue;
          }
          await sql.begin(async (tx) => {
            const [was] = (await tx`select paused_for_funds and status = 'paused' as wakes from app.agents where id = ${c.id} for update`) as { wakes: boolean }[];
            // Only a row still due flips: a delete that raced the handover keeps its own state for the closer. An agent born
            // paused for want of funds (provision saveActive) is resumed; one its owner paused stays paused.
            const done = (await tx`update app.agents set reserve_state = 'self_paid', reserve_tx = ${r.tx},
                                     reserve_usdc_units = ${r.units === null ? null : r.units.toString()},
                                     pays_own_fees = ${r.selfPaying}, reserve_attempts = 0, reserve_error = null, reserve_next_at = null,
                                     status = case when paused_for_funds and status = 'paused' then 'active' else status end,
                                     paused_for_funds = false
                                   where id = ${c.id} and reserve_state = 'due' returning id`) as unknown[];
            if (was?.wakes && done.length > 0) await skipMissedSlots(tx as unknown as Db, c.id);
          });
          log({ event: 'agent_reserves_handed', agent: c.id, ...(r.tx ? { tx: r.tx } : { found: 'not_sponsored' }) });
          n.handed++;
        } catch (e) {
          const code = errorCode(e);
          const attempt = c.attempts + 1;
          await sql`update app.agents set reserve_attempts = ${attempt}, reserve_error = ${code},
                           reserve_next_at = now() + ${retryDelayS(attempt)} * interval '1 second'
                    where id = ${c.id}`;
          log({ event: 'agent_reserves_retry', agent: c.id, attempt, code });
          n.failed++;
        }
      }
      return n;
    },

    responsor(agentId, address) {
      return send(agentId, address, (s) => buildResponsorTx(s, address, passphrase));
    },
  };
}

/** The live chain side: Horizon for the account, the quote and the submit; Soroban RPC for the sponsor's sequence. */
export function reserveChainOver(c: {
  sponsorPublicKey: string;
  sponsor: { signTransaction(x: string, p: string): Promise<string> };
  soroban: { getAccount(id: string): Promise<Account> };
  horizonSubmit(x: string): Promise<{ hash: string }>;
  withSponsorLock<T>(fn: () => Promise<T>): Promise<T>;
  fetch?: typeof fetch;
}): ReserveChain {
  const doFetch = c.fetch ?? fetch;
  const [code, issuer] = TESTNET.usdc.split(':') as [string, string];
  const units = (s: string) => {
    const [w, f = ''] = s.split('.');
    return BigInt(w!) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
  };
  return {
    sponsorPublicKey: c.sponsorPublicKey,
    async account(id) {
      const res = await doFetch(`${TESTNET.horizonUrl}/accounts/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`horizon_${res.status}`);
      const a = (await res.json()) as {
        sponsor?: string;
        subentry_count: number;
        num_sponsoring?: number;
        num_sponsored?: number;
        balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }[];
      };
      const usdc = a.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
      const native = a.balances.find((b) => b.asset_type === 'native');
      // The same minimum balance the closer reads (close.ts): what the account itself must keep.
      const minimum = BigInt(Math.max(0, 2 + a.subentry_count + (a.num_sponsoring ?? 0) - (a.num_sponsored ?? 0))) * 5_000_000n;
      const xlm = units(native?.balance ?? '0') - units(native?.selling_liabilities ?? '0') - minimum;
      return { sponsored: typeof a.sponsor === 'string', usdc: units(usdc?.balance ?? '0'), xlm: xlm > 0n ? xlm : 0n };
    },
    async quote(destStroops) {
      const res = await doFetch(
        `${TESTNET.horizonUrl}/paths/strict-receive?source_assets=${code}:${issuer}&destination_asset_type=native&destination_amount=${unitsToAmount(destStroops)}`,
      );
      if (!res.ok) throw fail(`horizon_${res.status}`);
      type Hop = { asset_type: string; asset_code?: string; asset_issuer?: string };
      const j = (await res.json()) as { _embedded?: { records?: { source_amount: string; path: Hop[] }[] } };
      const best = (j._embedded?.records ?? []).map((r) => ({ sendUnits: units(r.source_amount), path: r.path })).sort((a, b) => (a.sendUnits < b.sendUnits ? -1 : 1))[0];
      if (!best) return null;
      return { sendUnits: best.sendUnits, path: best.path.map((h) => (h.asset_type === 'native' ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!))) };
    },
    async feeCharged(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw fail('bad_hash');
      const res = await doFetch(`${TESTNET.horizonUrl}/transactions/${hash}`);
      if (!res.ok) throw fail(`horizon_${res.status}`);
      const t = (await res.json()) as { fee_charged?: string | number };
      if (t.fee_charged === undefined || !/^\d+$/.test(String(t.fee_charged))) throw fail('horizon_fee');
      return BigInt(t.fee_charged);
    },
    sponsorAccount: () => c.soroban.getAccount(c.sponsorPublicKey),
    signSponsor: (x, p) => c.sponsor.signTransaction(x, p),
    submit: (x) => c.horizonSubmit(x),
    withSponsorLock: (fn) => c.withSponsorLock(fn),
  };
}
