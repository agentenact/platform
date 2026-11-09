/**
 * What the agent did on chain from its own wallets (GET /api/agents/:id/wallets/history), newest first per network.
 * Anything malformed is dropped, never shown; a network the api could not read stays `unavailable`, never an empty list.
 */
import type { ChainTx } from '@/lib/agent-types';
import { bannedWord } from '@/lib/words';

export type MoveKind = 'hire' | 'swap' | 'sent' | 'received' | 'other';
export interface Move {
  direction: 'in' | 'out';
  /** A plain ticker, or null for one the chain gave no plain name (shown as "unlisted coin"). */
  symbol: string | null;
  amount: string;
}
export interface HistoryTx {
  tx: ChainTx;
  at: string;
  kind: MoveKind;
  ok: boolean;
  moves: Move[];
  counterparty: string | null;
  /** A hire's sealed decision, once it has landed on Stellar. */
  decision: ChainTx | null;
}
export interface ChainHistory {
  network: string;
  label: string;
  state: 'ok' | 'unavailable';
  txs: HistoryTx[];
}

const KINDS: readonly string[] = ['hire', 'swap', 'sent', 'received', 'other'];
const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^\d{1,40}(\.\d{1,36})?$/;
const TICKER = /^[A-Za-z0-9.$+-]{1,12}$/;
const ADDRESS = /^(G[A-Z2-7]{55}|0x[0-9a-f]{40})$/;
const NETWORK = /^(stellar:testnet|eip155:\d{1,12})$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function asMoves(v: unknown): Move[] | null {
  if (!Array.isArray(v) || v.length > 8) return null;
  const out: Move[] = [];
  for (const m of v) {
    if (!isObj(m) || (m.direction !== 'in' && m.direction !== 'out') || typeof m.amount !== 'string' || !AMOUNT.test(m.amount) || typeof m.symbol !== 'string') return null;
    out.push({ direction: m.direction, symbol: TICKER.test(m.symbol) && bannedWord(m.symbol) === null ? m.symbol : null, amount: m.amount });
  }
  return out;
}

function asTx(network: string, v: unknown): HistoryTx | null {
  if (!isObj(v) || typeof v.hash !== 'string' || !HEX64.test(v.hash) || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return null;
  if (typeof v.kind !== 'string' || !KINDS.includes(v.kind) || typeof v.ok !== 'boolean') return null;
  const moves = asMoves(v.moves);
  if (!moves) return null;
  const d = isObj(v.decision) && v.decision.status === 'sent' && typeof v.decision.tx === 'string' && HEX64.test(v.decision.tx) ? { hash: v.decision.tx, network: 'stellar:testnet' } : null;
  return {
    tx: { hash: v.hash, network },
    at: v.at,
    kind: v.kind as MoveKind,
    ok: v.ok,
    moves,
    counterparty: typeof v.counterparty === 'string' && ADDRESS.test(v.counterparty) ? v.counterparty : null,
    decision: v.kind === 'hire' ? d : null,
  };
}

export function asHistory(json: unknown): ChainHistory[] | null {
  const list = isObj(json) ? json.chains : undefined;
  if (!Array.isArray(list)) return null;
  const out: ChainHistory[] = [];
  for (const c of list) {
    if (!isObj(c) || typeof c.network !== 'string' || !NETWORK.test(c.network) || typeof c.label !== 'string' || c.label.length > 40) continue;
    if (c.state === 'unavailable') out.push({ network: c.network, label: c.label, state: 'unavailable', txs: [] });
    else if (c.state === 'ok' && Array.isArray(c.txs)) out.push({ network: c.network, label: c.label, state: 'ok', txs: c.txs.slice(0, 20).flatMap((t) => asTx(c.network as string, t) ?? []) });
  }
  return out;
}
