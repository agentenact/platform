/**
 * What the agent did on chain from its own wallets, every network it holds one on (agents/wallets.ts): the newest
 * transactions with what moved in and out. READ-ONLY public reads, nothing signs here.
 *
 * Sources: Stellar from Horizon (tools/payments.ts: classic and path payments, Soroban transfers); EVM from the network's
 * Blockscout api (full history, native coin and tokens; plain JSON-RPC nodes keep only an hour). A transaction the agent paid
 * to hire (a settled app.spend row) is a `hire` and carries its run's decision seal. Tokens Blockscout flags as scams are
 * dropped (airdropped junk), and a symbol that is not a plain ticker reads as `?`. A failed read is `unavailable`, never
 * an empty list. Answers are kept for a minute per agent: the page refreshes far more often than chains change.
 */
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import { EVM_TESTNETS, type EvmTestnet } from '../keys/contract.js';
import type { AgentKeys } from '../keys/rpc.js';
import type { Seals } from '../seals/index.js';
import type { SafeFetch } from '../tools/safe-fetch.js';

export type HistoryNetwork = 'stellar:testnet' | EvmTestnet;
export type MoveKind = 'hire' | 'swap' | 'sent' | 'received' | 'other';

export interface Move {
  direction: 'in' | 'out';
  symbol: string;
  amount: string;
}
export interface HistoryTx {
  /** Lowercase hex without 0x, as app.spend and the panel store hashes. */
  hash: string;
  at: string;
  kind: MoveKind;
  /** false: the chain ran it and it failed (the fee was still paid). */
  ok: boolean;
  moves: Move[];
  /** The other side when there is one (for a hire, who was paid). */
  counterparty: string | null;
  /** A hire's run and that run's sealed decision (null until a seal exists). */
  runId?: string;
  decision?: { status: 'pending' | 'sent' | 'failed'; tx: string | null } | null;
}
export interface ChainHistory {
  network: HistoryNetwork;
  label: string;
  /** none: no wallet on this network yet. */
  state: 'ok' | 'unavailable' | 'none';
  txs: HistoryTx[];
}
export interface WalletHistory {
  list(userId: string, agentId: string): Promise<ChainHistory[]>;
}

export const HISTORY_TXS = 20;
const HISTORY_DAYS = 30;
const TTL_MS = 60_000;
/** Where each EVM testnet's history is read. A network without a public Blockscout is left out of the list. */
const BLOCKSCOUT: Partial<Record<EvmTestnet, { label: string; url: string }>> = {
  'eip155:84532': { label: 'Base Sepolia', url: 'https://base-sepolia.blockscout.com' },
  'eip155:421614': { label: 'Arbitrum Sepolia', url: 'https://arbitrum-sepolia.blockscout.com' },
};
const TICKER = /^[A-Za-z0-9.$+-]{1,12}$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hashOf = (h: unknown): string | null => (typeof h === 'string' && HEX64.test(h) ? h.replace(/^0x/, '').toLowerCase() : null);
const addrOf = (v: unknown): string | null => (isObj(v) && typeof v.hash === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.hash) ? v.hash.toLowerCase() : null);

/** A count of 10^-decimals units as a plain decimal, no trailing zeros (as tools/wallets.ts writes amounts; that reader stays off this graph). */
function decimal(n: bigint, decimals: number): string {
  const s = n.toString().padStart(decimals + 1, '0');
  const f = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return `${decimals ? s.slice(0, -decimals) : s}${f ? `.${f}` : ''}`;
}

/** sent / received / swap from the moves alone; a hire is decided by the spend rows. */
function kindOf(moves: Move[]): MoveKind {
  const out = moves.some((m) => m.direction === 'out');
  const inn = moves.some((m) => m.direction === 'in');
  return out && inn ? 'swap' : out ? 'sent' : inn ? 'received' : 'other';
}

/** Same asset and direction summed into one move, so a transaction with several transfers reads once. */
function merged(moves: (Move & { units: bigint; decimals: number })[]): Move[] {
  const by = new Map<string, Move & { units: bigint; decimals: number }>();
  for (const m of moves) {
    const k = `${m.direction}:${m.symbol}:${m.decimals}`;
    const prev = by.get(k);
    by.set(k, prev ? { ...prev, units: prev.units + m.units } : m);
  }
  return [...by.values()].map((m) => ({ direction: m.direction, symbol: m.symbol, amount: decimal(m.units, m.decimals) }));
}

export function createWalletHistory(d: {
  sql: Db;
  keys: Pick<AgentKeys, 'publicKey' | 'evmAddress'>;
  safeFetch: SafeFetch;
  /** The toolbox's read-only Horizon payments read (tools/payments.ts). */
  stellarPayments(a: { account: string; network: 'testnet'; direction: 'both'; since_s: number; limit: number }): Promise<{ payments: { direction: 'in' | 'out'; from: string; to: string; asset: string; amount: string; tx: string; at: string }[] }>;
  seals?: Pick<Seals, 'decisions'>;
  now?: () => number;
}): WalletHistory {
  const now = d.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<ChainHistory[]> }>();

  async function json(url: string): Promise<unknown> {
    const r = await d.safeFetch(url, { headers: { accept: 'application/json' }, timeoutMs: 8000, maxBytes: 3_000_000 });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return JSON.parse(new TextDecoder().decode(r.body));
  }

  async function stellar(account: string): Promise<HistoryTx[]> {
    const r = await d.stellarPayments({ account, network: 'testnet', direction: 'both', since_s: HISTORY_DAYS * 86_400, limit: 50 });
    const by = new Map<string, { at: string; moves: (Move & { units: bigint; decimals: number })[]; other: string | null }>();
    for (const p of r.payments) {
      const hash = hashOf(p.tx);
      if (!hash) continue;
      const symbol = p.asset === 'XLM' ? 'XLM' : p.asset.split(':')[0]!;
      const [i, f = ''] = p.amount.split('.');
      const units = BigInt(i!) * 10_000_000n + BigInt(f.padEnd(7, '0').slice(0, 7));
      const t = by.get(hash) ?? { at: p.at, moves: [], other: null };
      t.moves.push({ direction: p.direction, symbol: TICKER.test(symbol) ? symbol : '?', amount: p.amount, units, decimals: 7 });
      const other = p.direction === 'out' ? p.to : p.from;
      if (other !== account) t.other ??= other;
      by.set(hash, t);
    }
    return [...by.entries()].map(([hash, t]) => {
      const moves = merged(t.moves);
      // A path payment to itself is the agent trading one asset for another.
      const self = t.other === null && moves.length > 0;
      return { hash, at: t.at, kind: self ? 'swap' : kindOf(moves), ok: true, moves, counterparty: t.other };
    });
  }

  async function evm(network: EvmTestnet, address: string): Promise<HistoryTx[]> {
    const base = `${BLOCKSCOUT[network]!.url}/api/v2/addresses/${address}`;
    // Blockscout takes one direction per call (filter=from | to); a transaction to itself comes back in both.
    const [sent, got, transfers] = await Promise.all([json(`${base}/transactions?filter=from`), json(`${base}/transactions?filter=to`), json(`${base}/token-transfers`)]);
    const items = (v: unknown): unknown[] => {
      if (!isObj(v) || !Array.isArray(v.items)) throw new Error('shape');
      return v.items;
    };
    const me = address.toLowerCase();
    const since = now() - HISTORY_DAYS * 86_400_000;
    const by = new Map<string, { at: string; ok: boolean; moves: (Move & { units: bigint; decimals: number })[]; other: string | null }>();
    const entry = (hash: string, at: string) => {
      const t = by.get(hash) ?? { at, ok: true, moves: [], other: null };
      by.set(hash, t);
      return t;
    };
    const seen = new Set<string>();
    for (const x of [...items(sent), ...items(got)]) {
      if (!isObj(x)) continue;
      const hash = hashOf(x.hash);
      const at = typeof x.timestamp === 'string' ? x.timestamp : '';
      if (!hash || seen.has(hash) || !(Date.parse(at) >= since)) continue;
      seen.add(hash);
      const from = addrOf(x.from);
      const to = addrOf(x.to);
      if (from !== me && to !== me) continue;
      const t = entry(hash, at);
      t.ok = x.status !== 'error';
      const value = typeof x.value === 'string' && /^\d{1,40}$/.test(x.value) ? BigInt(x.value) : 0n;
      if (t.ok && value > 0n) t.moves.push({ direction: from === me ? 'out' : 'in', symbol: 'ETH', amount: '', units: value, decimals: 18 });
      t.other ??= from === me ? to : from;
    }
    for (const x of items(transfers)) {
      if (!isObj(x) || !isObj(x.token) || !isObj(x.total)) continue;
      if (x.token.reputation === 'scam' || x.token.is_scam === true) continue;
      const hash = hashOf(x.transaction_hash);
      const at = typeof x.timestamp === 'string' ? x.timestamp : '';
      if (!hash || !(Date.parse(at) >= since)) continue;
      const from = addrOf(x.from);
      const to = addrOf(x.to);
      const value = typeof x.total.value === 'string' && /^\d{1,60}$/.test(x.total.value) ? BigInt(x.total.value) : null;
      const decimals = Number(x.total.decimals ?? x.token.decimals);
      if (value === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || (from !== me && to !== me) || from === to) continue;
      const symbol = typeof x.token.symbol === 'string' && TICKER.test(x.token.symbol) ? x.token.symbol : '?';
      const t = entry(hash, at);
      t.moves.push({ direction: from === me ? 'out' : 'in', symbol, amount: '', units: value, decimals });
      t.other ??= from === me ? to : from;
    }
    return [...by.entries()].map(([hash, t]) => {
      const moves = merged(t.moves);
      return { hash, at: t.at, kind: kindOf(moves), ok: t.ok, moves, counterparty: t.other };
    });
  }

  /** Hires the agent paid (settled spend rows with these hashes), each with its run's decision seal. */
  async function hires(agentId: string, list: HistoryTx[]): Promise<void> {
    if (list.length === 0) return;
    const rows = (await d.sql`select tx_hash, run_id, payee from app.spend
                              where agent_id = ${agentId} and decision = 'settled' and tx_hash = any(${`{${list.map((t) => t.hash).join(',')}}`}::text[])`) as { tx_hash: string; run_id: string | null; payee: string }[];
    if (rows.length === 0) return;
    const runIds = [...new Set(rows.flatMap((r) => (r.run_id ? [r.run_id] : [])))];
    const decided = d.seals && runIds.length ? await d.seals.decisions(agentId, runIds).catch(() => new Map()) : new Map();
    for (const t of list) {
      const r = rows.find((x) => x.tx_hash === t.hash);
      if (!r) continue;
      t.kind = 'hire';
      t.counterparty = r.payee;
      if (r.run_id) {
        t.runId = r.run_id;
        t.decision = decided.get(r.run_id) ?? null;
      }
    }
  }

  async function read(agentId: string): Promise<ChainHistory[]> {
    const [g, evmAddress] = await Promise.all([d.keys.publicKey(agentId), d.keys.evmAddress(agentId)]);
    const chains: { network: HistoryNetwork; label: string; read: (() => Promise<HistoryTx[]>) | null }[] = [
      { network: 'stellar:testnet', label: 'Stellar testnet', read: g ? () => stellar(g) : null },
      ...(Object.keys(EVM_TESTNETS) as EvmTestnet[]).flatMap((n) => {
        const b = BLOCKSCOUT[n];
        return b ? [{ network: n, label: b.label, read: evmAddress ? () => evm(n, evmAddress) : null }] : [];
      }),
    ];
    return Promise.all(
      chains.map(async (c): Promise<ChainHistory> => {
        if (!c.read) return { network: c.network, label: c.label, state: 'none', txs: [] };
        try {
          const txs = (await c.read()).sort((x, y) => y.at.localeCompare(x.at)).slice(0, HISTORY_TXS);
          await hires(agentId, txs);
          return { network: c.network, label: c.label, state: 'ok', txs };
        } catch {
          return { network: c.network, label: c.label, state: 'unavailable', txs: [] };
        }
      }),
    );
  }

  return {
    async list(userId, agentId) {
      const rows = (await d.sql`select 1 from app.agents where id = ${agentId} and user_id = ${userId}`) as unknown[];
      if (!rows[0]) throw httpError(404, 'not_found');
      const hit = cache.get(agentId);
      if (hit && now() - hit.at < TTL_MS) return hit.value;
      const value = read(agentId);
      cache.set(agentId, { at: now(), value });
      // A read that failed somewhere is kept only briefly: the next page refresh tries again.
      value.then(
        (v) => v.some((c) => c.state === 'unavailable') && cache.get(agentId)?.value === value && cache.set(agentId, { at: now() - TTL_MS + 10_000, value }),
        () => cache.get(agentId)?.value === value && cache.delete(agentId),
      );
      if (cache.size > 2000) for (const [k, e] of cache) if (now() - e.at >= TTL_MS) cache.delete(k);
      return value;
    },
  };
}
