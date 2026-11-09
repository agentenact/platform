/**
 * Testnet credit worker (Kerem, 2026-11-01): keeps a little testnet USDC in every live hosted agent's wallet, so
 * hire_agent (owner chat, owner MCP, missions with approved targets) can pay other agents. Before this every hosted
 * agent held 0 USDC and no hire could settle.
 *
 * The leader's `tick` claims active agents due a look (credit_next_at), CLAIM_BATCH at a time:
 * - no account yet, or the reserves still due (a credit must never pay an extra agent's reserves): look again later.
 *   The exception is an agent paused for want of funds (FEE_MODEL=agent, reserve.ts): on testnet the credit IS its first
 *   funding, which it then spends on its own reserves and fee float, so a new testnet agent starts without a faucet;
 * - holding CREDIT_FLOOR_UNITS or more: look again in FULL_WAIT_S;
 * - else the sponsor buys exactly 1 USDC with its own XLM (credit-tx.ts) and sends it, then waits CREDIT_EVERY_S.
 * The vault enforces the same per-agent spacing and a per-day total on its own; a refusal is a wait, never a retry loop.
 * Every look re-reads the chain first, so a credit whose answer was lost is never sent twice in a row: the balance
 * shows it.
 *
 * Off unless TESTNET_CREDIT=on. Testnet only: the sponsor policy refuses any other network.
 */
import { Asset, type Account } from '@stellar/stellar-sdk';
import type { Db } from '../db/index.js';
import { TESTNET } from '../owner-client/testnet.js';
import { buildCreditTx, CREDIT_AMOUNT, CREDIT_MAX_SEND_STROOPS } from './credit-tx.js';

/** Below this (7 decimals) an agent gets a credit: 0.20 USDC, so an agent that still has some is left alone. */
export const CREDIT_FLOOR_UNITS = 2_000_000n;
/** Room above the quote for the book moving between the quote and the ledger: 2 %. */
export const CREDIT_SLIPPAGE_PERCENT = 2n;
/** After a credit: one a day at most (the vault's own spacing is shorter, VAULT_CREDIT_EVERY_H, so a lost credit recovers). */
export const CREDIT_EVERY_S = 24 * 3600;
/** An agent that still holds enough is looked at again after this. */
export const FULL_WAIT_S = 6 * 3600;
/** No account yet, reserves due, or a vault/chain refusal: look again after this. */
export const WAIT_S = 3600;
const CLAIM_LEASE_S = 300;
const CLAIM_BATCH = 5;

export interface CreditChain {
  /** USDC held in 7-decimal units, or null when the account does not exist. Throws when Horizon cannot say. */
  usdc(id: string): Promise<bigint | null>;
  /** The cheapest XLM route to exactly CREDIT_AMOUNT of USDC right now, or null when the DEX has none. */
  quote(): Promise<{ sendStroops: bigint; path: Asset[] } | null>;
  sponsorAccount(): Promise<Account>;
  signSponsor(txXdr: string, passphrase: string): Promise<string>;
  submit(txXdr: string): Promise<{ hash: string }>;
  withSponsorLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TestnetCredits {
  tick(): Promise<{ credited: number; full: number; waiting: number; failed: number }>;
}

const errorCode = (e: unknown): string => {
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string') return `vault_${reason}`.slice(0, 60);
  const m = e instanceof Error ? e.message : '';
  if (/op_too_few_offers|op_over_source_max/.test(m)) return 'swap_failed';
  if (/op_underfunded/.test(m)) return 'sponsor_underfunded';
  if (/tx_bad_seq/.test(m)) return 'bad_seq';
  if (/no_trust|op_no_trust/.test(m)) return 'no_trustline';
  if (/Horizon submit failed/.test(m)) return `horizon_${/failed: (\d{3})/.exec(m)?.[1] ?? 'error'}`;
  if (/sponsor refuses|above cap/.test(m)) return 'sponsor_refused';
  if (/credit: /.test(m)) return m.slice(8, 60);
  return 'error';
};

export function createTestnetCredits(d: {
  sql: Db;
  chain: CreditChain;
  keys: { publicKey(agentId: string): Promise<string | null> };
  killed?: () => boolean;
  log: (e: Record<string, unknown>) => void;
}): TestnetCredits {
  const { sql, chain, keys, log } = d;
  const passphrase = TESTNET.passphrase;

  const later = (id: string, s: number) => sql`update app.agents set credit_next_at = now() + ${s} * interval '1 second' where id = ${id}`;

  async function claim(): Promise<{ id: string; reserve: string; waits: boolean }[]> {
    return (await sql`update app.agents a set credit_next_at = now() + ${CLAIM_LEASE_S} * interval '1 second'
                      from (select id from app.agents
                            where (status = 'active' or (status = 'paused' and paused_for_funds)) and deleted_at is null
                              and coalesce(credit_next_at, now()) <= now()
                            order by credit_next_at nulls first limit ${CLAIM_BATCH} for update skip locked) due
                      where a.id = due.id
                      returning a.id, a.reserve_state as reserve, a.paused_for_funds as waits`) as { id: string; reserve: string; waits: boolean }[];
  }

  return {
    async tick() {
      const n = { credited: 0, full: 0, waiting: 0, failed: 0 };
      if (d.killed?.()) return n;
      for (const c of await claim()) {
        try {
          const address = c.reserve === 'due' && !c.waits ? null : await keys.publicKey(c.id);
          const held = address ? await chain.usdc(address) : null;
          if (!address || held === null) {
            await later(c.id, WAIT_S);
            n.waiting++;
            continue;
          }
          if (held >= CREDIT_FLOOR_UNITS) {
            await later(c.id, FULL_WAIT_S);
            n.full++;
            continue;
          }
          const q = await chain.quote();
          if (!q) throw new Error('credit: no_path');
          const sendMax = (q.sendStroops * (100n + CREDIT_SLIPPAGE_PERCENT)) / 100n + 1n;
          if (sendMax > CREDIT_MAX_SEND_STROOPS) throw new Error('credit: price_above_cap');
          const hash = await chain.withSponsorLock(async () => {
            const tx = buildCreditTx(await chain.sponsorAccount(), address, sendMax, q.path, passphrase);
            return (await chain.submit(await chain.signSponsor(tx.toXDR(), passphrase))).hash;
          });
          await sql`update app.agents set credit_at = now(), credit_tx = ${hash},
                           credit_next_at = now() + ${CREDIT_EVERY_S} * interval '1 second'
                    where id = ${c.id}`;
          log({ event: 'agent_credited', agent: c.id, tx: hash, usdc: CREDIT_AMOUNT });
          n.credited++;
        } catch (e) {
          const code = errorCode(e);
          await later(c.id, WAIT_S);
          log({ event: 'agent_credit_failed', agent: c.id, code });
          n.failed++;
        }
      }
      return n;
    },
  };
}

/** The live chain side: Horizon for the balance, the quote and the submit; Soroban RPC for the sponsor's sequence. */
export function creditChainOver(c: {
  sponsorPublicKey: string;
  sponsor: { signTransaction(x: string, p: string): Promise<string> };
  soroban: { getAccount(id: string): Promise<Account> };
  horizonSubmit(x: string): Promise<{ hash: string }>;
  withSponsorLock<T>(fn: () => Promise<T>): Promise<T>;
  fetch?: typeof fetch;
}): CreditChain {
  const doFetch = c.fetch ?? fetch;
  const [code, issuer] = TESTNET.usdc.split(':') as [string, string];
  const units = (s: string) => {
    const [w, f = ''] = s.split('.');
    return BigInt(w!) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
  };
  return {
    async usdc(id) {
      const res = await doFetch(`${TESTNET.horizonUrl}/accounts/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`credit: horizon_${res.status}`);
      const a = (await res.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
      const b = a.balances.find((x) => x.asset_code === code && x.asset_issuer === issuer);
      // No USDC trustline: a credit could not land. Treated as not there yet.
      return b ? units(b.balance) : null;
    },
    async quote() {
      const res = await doFetch(
        `${TESTNET.horizonUrl}/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=${code}&destination_asset_issuer=${issuer}&destination_amount=${CREDIT_AMOUNT}`,
      );
      if (!res.ok) throw new Error(`credit: horizon_${res.status}`);
      type Hop = { asset_type: string; asset_code?: string; asset_issuer?: string };
      const j = (await res.json()) as { _embedded?: { records?: { source_amount: string; path: Hop[] }[] } };
      const best = (j._embedded?.records ?? []).map((r) => ({ sendStroops: units(r.source_amount), path: r.path })).sort((a, b) => (a.sendStroops < b.sendStroops ? -1 : 1))[0];
      if (!best) return null;
      return { sendStroops: best.sendStroops, path: best.path.map((h) => (h.asset_type === 'native' ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!))) };
    },
    sponsorAccount: () => c.soroban.getAccount(c.sponsorPublicKey),
    signSponsor: (x, p) => c.sponsor.signTransaction(x, p),
    submit: (x) => c.horizonSubmit(x),
    withSponsorLock: (fn) => c.withSponsorLock(fn),
  };
}
