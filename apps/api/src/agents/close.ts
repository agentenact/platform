/**
 * The closer: what happens to a deleted agent's wallets (Kerem, 2026-10-30, "Soft delete + cüzdanı kapat"). Deleting
 * (agents.remove) only marks the agent; this unit then, one agent at a time:
 *
 *   Horizon read → sweep USDC to the owner → sweep XLM to the owner → trustline off + account merge → EVM check → key gone
 *
 * Each sweep and the merge is the agent's own tx (close-tx.ts), signed by the vault as the agent (which pins where the
 * money goes: the owner) and fee-bumped by the sponsor, so the agent spends no XLM. The merge returns the reserves the
 * sponsor paid at birth. Every step re-reads the chain first, so a retry after a lost answer repeats nothing.
 *
 * The vault key is destroyed only once the Stellar account is gone and no EVM wallet holds anything: a Base Sepolia
 * wallet with funds keeps every key (close_error evm_funds_kept), because destroying it would burn the owner's money.
 * A failure retries with a growing wait; after MAX_ATTEMPTS the agent is close_state 'failed' and its key is kept.
 *
 * Thirty days after deletion `purge` clears the agent's private content (memory, conversations, readings). Records and
 * seals stay: past proofs must keep checking out.
 */
import type { Account, Transaction } from '@stellar/stellar-sdk';
import type { Db } from '../db/index.js';
import { TESTNET } from '../owner-client/testnet.js';
import type { ChainId } from '../tools/schemas.js';
import type { WalletBalanceRead } from '../tools/wallets.js';
import { buildMergeTx, buildSweepTx, closeShape, feeBumpClose, type SweepAsset } from './close-tx.js';

export const MAX_ATTEMPTS = 8;
/** Seconds before retry n (1-based): 60, 120, 240, … capped at 6 hours. */
export const retryDelayS = (n: number) => Math.min(60 * 2 ** (n - 1), 21_600);
/** A claimed agent is hidden from other closers this long (a crashed close comes back after it). */
export const CLAIM_LEASE_S = 600;
/** Days a deleted agent's private content is kept before it is cleared. */
export const PURGE_AFTER_DAYS = 30;
const BATCH = 5;

export interface Holdings {
  /** USDC held, in 7-decimal units. */
  usdc: bigint;
  /** XLM the account may send, in stroops (its balance above its own, unsponsored minimum). */
  xlm: bigint;
  /** Trustlines other than USDC, offers and data entries: anything an account merge would refuse. */
  blockers: number;
  /** Whether the platform sponsor still holds the account's reserves (false once the agent took them over: reserve.ts). */
  sponsored: boolean;
}

export interface CloseChain {
  sponsorPublicKey: string;
  getAccount(id: string): Promise<Account>;
  /** null when the account does not exist (never created, or already merged). Throws when Horizon cannot say. */
  holdings(id: string): Promise<Holdings | null>;
  /** Simulates and assembles a Soroban tx. */
  prepare(tx: Transaction): Promise<Transaction>;
  /** The sponsor's signature on a close fee-bump (the vault's, behind its policy). */
  signSponsor(txXdr: string, passphrase: string): Promise<string>;
  /** Submits and waits for the ledger; throws on anything but success. */
  submit(txXdr: string): Promise<{ hash: string }>;
}

export interface CloseKeys {
  publicKey(agentId: string): Promise<string | null>;
  evmAddress(agentId: string): Promise<string | null>;
  solanaAddress?(agentId: string): Promise<string | null>;
  signClose(agentId: string, txXdr: string, passphrase: string): Promise<string>;
  destroy(agentId: string): Promise<void>;
}

export interface Closer {
  /** Closes one deleted agent's wallets now, if no other closer holds it. The delete route calls it without waiting. */
  close(agentId: string): Promise<void>;
  /** The leader's pass: due closes, then due purges. */
  tick(): Promise<{ closed: number; failed: number; purged: number }>;
}

/** A failure with a fixed code: what close_error stores. */
const fail = (code: string) => Object.assign(new Error(`close: ${code}`), { closeCode: code });

const errorCode = (e: unknown): string => {
  const own = (e as { closeCode?: unknown } | null)?.closeCode;
  if (typeof own === 'string') return own;
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string') return `vault_${reason}`.slice(0, 60);
  const m = e instanceof Error ? e.message : '';
  if (/tx_bad_seq/.test(m)) return 'bad_seq';
  if (/Horizon submit failed/.test(m)) return `horizon_${/failed: (\d{3})/.exec(m)?.[1] ?? 'error'}`;
  if (/simulation failed/.test(m)) return 'simulation_failed';
  if (/sponsor refuses|above cap/.test(m)) return 'sponsor_refused';
  return 'error';
};

/** Any amount above zero in an EVM wallet read. */
/** Every EVM testnet the vault signs for (keys/contract.ts EVM_TESTNETS), as the wallet reads name them. */
const EVM_CHAINS: ChainId[] = ['base-sepolia', 'arbitrum-sepolia', 'avalanche-fuji', 'polygon-amoy'];
const holdsAnything = (b: WalletBalanceRead) => b.balances.some((x) => Number(x.amount) > 0);

export function createCloser(d: {
  sql: Db;
  chain: CloseChain;
  keys: CloseKeys;
  /** Reads an EVM or Solana wallet; absent, an agent with such a wallet keeps its keys (unknown is never "empty"). */
  evmBalance?: (a: { chain: ChainId; address: string }) => Promise<WalletBalanceRead>;
  /** The kill switch: while it is on, nothing is closed (the queue waits). */
  killed?: () => boolean;
  /**
   * The sponsor takes a self-paid agent's reserves back (reserve.ts), so its XLM can be swept to an owner a merge cannot
   * reach (a C address). Absent, such an agent's reserves go with the merge to the sponsor.
   */
  responsor?: (agentId: string, address: string) => Promise<string>;
  log: (e: Record<string, unknown>) => void;
}): Closer {
  const { sql, chain, keys, log } = d;
  const passphrase = TESTNET.passphrase;

  /** Signs `inner` as the agent (the vault), fee-bumps it as the sponsor, submits it. Returns the hash. */
  async function send(agentId: string, address: string, inner: Transaction): Promise<string> {
    // The vault checks it too; a shape this side would not send is a bug here, not a refusal there.
    if (!closeShape(inner)) throw fail('bad_shape');
    inner.addSignature(address, await keys.signClose(agentId, inner.toXDR(), passphrase));
    const bumped = feeBumpClose(inner, chain.sponsorPublicKey, passphrase);
    return (await chain.submit(await chain.signSponsor(bumped.toXDR(), passphrase))).hash;
  }

  async function sweep(agentId: string, address: string, asset: SweepAsset, to: string, amount: bigint): Promise<string> {
    const tx = await chain.prepare(buildSweepTx(await chain.getAccount(address), asset, to, amount, passphrase));
    return send(agentId, address, tx);
  }

  /** One full attempt. Returns what it left behind: null, or a note (evm_funds_kept) on a close that is done. */
  async function run(agentId: string): Promise<{ txs: string[]; note: string | null }> {
    const txs: string[] = [];
    const rows = (await sql`select u.owner_address from app.agents a join app.users u on u.id = a.user_id
                            where a.id = ${agentId} and a.status = 'revoked'`) as { owner_address: string | null }[];
    if (!rows[0]) throw fail('not_deleted');
    const owner = rows[0].owner_address;
    const address = await keys.publicKey(agentId);
    if (address) {
      let held = await chain.holdings(address);
      if (held) {
        if (held.blockers > 0) throw fail('other_holdings');
        const mergeTo = owner && /^G[A-Z2-7]{55}$/.test(owner) ? owner : chain.sponsorPublicKey;
        // Reserves the agent paid itself go back to its owner: a G owner gets them with the merge, a C owner by a sweep.
        if (!held.sponsored && owner && mergeTo !== owner && d.responsor) {
          txs.push(await d.responsor(agentId, address));
          held = await chain.holdings(address);
          if (!held || !held.sponsored) throw fail('responsor_unseen');
        }
        if ((held.usdc > 0n || held.xlm > 0n) && !owner) throw fail('no_owner');
        if (held.usdc > 0n) txs.push(await sweep(agentId, address, 'usdc', owner!, held.usdc));
        if (held.xlm > 0n) txs.push(await sweep(agentId, address, 'xlm', owner!, held.xlm));
        held = txs.length ? await chain.holdings(address) : held;
        if (held) {
          // A sweep that landed leaves zero; anything else means the chain moved under us: try again later.
          if (held.usdc > 0n) throw fail('not_empty');
          txs.push(await send(agentId, address, buildMergeTx(await chain.getAccount(address), mergeTo, passphrase)));
        }
      }
    }
    // The EVM and Solana wallets decide whether the keys may go: never destroy a key whose wallet still holds something,
    // on any network it can pay on (one EVM key serves every EVM testnet).
    const evm = await keys.evmAddress(agentId);
    if (evm) {
      if (!d.evmBalance) return { txs, note: 'evm_funds_kept' };
      for (const chain of EVM_CHAINS) {
        if (holdsAnything(await d.evmBalance({ chain, address: evm }))) return { txs, note: 'evm_funds_kept' };
      }
    }
    const sol = (await keys.solanaAddress?.(agentId)) ?? null;
    if (sol) {
      if (!d.evmBalance) return { txs, note: 'solana_funds_kept' };
      if (holdsAnything(await d.evmBalance({ chain: 'solana-devnet', address: sol }))) return { txs, note: 'solana_funds_kept' };
    }
    await keys.destroy(agentId);
    return { txs, note: null };
  }

  /** Takes the agent for this closer (one at a time per agent, across replicas): its attempt number, or null. */
  async function claim(agentId: string | null): Promise<{ id: string; attempt: number }[]> {
    return (await sql`update app.agents a set close_next_at = now() + ${CLAIM_LEASE_S} * interval '1 second', close_attempts = a.close_attempts + 1
                      from (select id from app.agents
                            where close_state = 'pending' and close_next_at <= now() and (${agentId}::uuid is null or id = ${agentId}::uuid)
                            order by close_next_at limit ${agentId ? 1 : BATCH} for update skip locked) due
                      where a.id = due.id
                      returning a.id, a.close_attempts as attempt`) as { id: string; attempt: number }[];
  }

  async function attempt(c: { id: string; attempt: number }): Promise<'closed' | 'failed' | 'retry'> {
    try {
      const { txs, note } = await run(c.id);
      await sql`update app.agents set close_state = 'closed', close_next_at = null, close_error = ${note},
                       close_txs = close_txs || ${`{${txs.join(',')}}`}::text[]
                where id = ${c.id}`;
      log({ event: 'agent_closed', agent: c.id, txs, ...(note ? { note } : {}) });
      return 'closed';
    } catch (e) {
      const code = errorCode(e);
      const last = c.attempt >= MAX_ATTEMPTS;
      await sql`update app.agents set close_error = ${code},
                       close_state = ${last ? 'failed' : 'pending'},
                       close_next_at = ${last ? null : new Date(Date.now() + retryDelayS(c.attempt) * 1000)}
                where id = ${c.id}`;
      log({ event: last ? 'agent_close_failed' : 'agent_close_retry', agent: c.id, attempt: c.attempt, code });
      return last ? 'failed' : 'retry';
    }
  }

  async function purge(): Promise<number> {
    const due = (await sql`select id from app.agents where deleted_at is not null and purged_at is null
                           and deleted_at < now() - ${PURGE_AFTER_DAYS} * interval '1 day' order by deleted_at limit 20`) as { id: string }[];
    for (const { id } of due) {
      await sql.begin(async (tx) => {
        await tx`delete from app.memory where agent_id = ${id}`;
        await tx`delete from app.check_log where agent_id = ${id}`;
        await tx`update app.runs set steps = '[]'::jsonb where agent_id = ${id} and steps <> '[]'::jsonb`;
        await tx`update app.runs set result = null, live_text = null, call_details = null where agent_id = ${id} and (result is not null or live_text is not null or call_details is not null)`;
        await tx`update app.agent_specs set build_prompt = null where agent_id = ${id} and build_prompt is not null`;
        // Chat words go; each turn's leaf (hashes and salt) stays, so its seals can still be checked by whoever kept the words.
        await tx`update app.chat_turns t set question = '', answer = '' from app.chat_sessions s
                 where s.id = t.session_id and s.agent_id = ${id} and (t.question <> '' or t.answer <> '')`;
        await tx`update app.chat_sessions set title = null where agent_id = ${id} and title is not null`;
        await tx`update app.agents set purged_at = now() where id = ${id}`;
      });
      log({ event: 'agent_purged', agent: id });
    }
    return due.length;
  }

  return {
    async close(agentId) {
      if (d.killed?.()) return;
      const [c] = await claim(agentId);
      if (c) await attempt(c);
    },
    async tick() {
      let closed = 0;
      let failed = 0;
      for (const c of d.killed?.() ? [] : await claim(null)) {
        const r = await attempt(c);
        if (r === 'closed') closed++;
        else if (r === 'failed') failed++;
      }
      return { closed, failed, purged: await purge() };
    },
  };
}

/** Horizon's balances in units: USDC (7 decimals) and the XLM the account may send. */
export function holdingsOf(account: {
  /** Horizon names the account's sponsor; absent when the account pays its own reserves. */
  sponsor?: string;
  balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}): Holdings {
  const units = (s: string | undefined) => {
    const [w, f = ''] = (s ?? '0').split('.');
    return BigInt(w!) * 10_000_000n + BigInt((f + '0000000').slice(0, 7));
  };
  const usdc = account.balances.find((b) => `${b.asset_code}:${b.asset_issuer}` === TESTNET.usdc);
  const native = account.balances.find((b) => b.asset_type === 'native');
  // Minimum balance: (2 + subentries + sponsoring − sponsored) × 0.5 XLM. A birth-sponsored account's is zero.
  const reserves = BigInt(Math.max(0, 2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0))) * 5_000_000n;
  const spendable = units(native?.balance) - units(native?.selling_liabilities) - reserves;
  return {
    usdc: units(usdc?.balance),
    xlm: spendable > 0n ? spendable : 0n,
    // Subentries beyond the USDC trustline: other trustlines, offers, data, signers.
    blockers: Math.max(0, account.subentry_count - (usdc ? 1 : 0)),
    sponsored: typeof account.sponsor === 'string',
  };
}

/** The live chain side: Horizon for holdings and the submit, Soroban RPC for the account and the simulation. */
export function closeChainOver(c: {
  sponsorPublicKey: string;
  sponsor: { signTransaction(x: string, p: string): Promise<string> };
  soroban: { getAccount(id: string): Promise<Account>; prepare?(tx: Transaction): Promise<{ prepared: Transaction }> };
  horizonSubmit(x: string): Promise<{ hash: string }>;
  fetch?: typeof fetch;
}): CloseChain {
  const doFetch = c.fetch ?? fetch;
  return {
    sponsorPublicKey: c.sponsorPublicKey,
    getAccount: (id) => c.soroban.getAccount(id),
    async holdings(id) {
      const res = await doFetch(`${TESTNET.horizonUrl}/accounts/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw fail(`horizon_${res.status}`);
      return holdingsOf((await res.json()) as Parameters<typeof holdingsOf>[0]);
    },
    async prepare(tx) {
      if (!c.soroban.prepare) throw fail('no_simulation');
      return (await c.soroban.prepare(tx)).prepared;
    },
    signSponsor: (x, p) => c.sponsor.signTransaction(x, p),
    submit: (x) => c.horizonSubmit(x),
  };
}
