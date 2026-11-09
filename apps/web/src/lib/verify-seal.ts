/**
 * Seals on /verify. A seal is an agent's own Stellar testnet transaction: one no-op `bump_sequence` and a 32-byte memo
 * hash, sha256 of a document the owner keeps (api seals/format.ts: `ae.check/1`, `ae.decision/1`, `ae.chat/1`). The
 * chain shows who committed which hash when; the document, pasted by whoever holds it, shows what was committed.
 * Everything here reads public data only (Horizon testnet, the public discovery api) and sends no document anywhere.
 */
import { getJson, type AgentProfile, type AgentsPage } from './explore';

export const HORIZON = 'https://horizon-testnet.stellar.org';

export interface ChainTx {
  hash: string;
  /** The source of the (inner) transaction: the account whose key signed it. */
  source: string;
  /** Who paid the fee (the fee-bump's account, or the source itself). */
  feeAccount: string;
  at: string;
  ledger: number;
  /** The memo as 64 lowercase hex, when it is a hash memo. */
  memoHash: string | null;
  ops: string[];
  successful: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function base64ToHex(b64: string): string | null {
  try {
    const bin = atob(b64);
    return [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** One testnet transaction from Horizon, or null when Horizon does not know it. Throws when Horizon cannot be read. */
export async function readTx(hash: string, f: typeof fetch = fetch): Promise<ChainTx | null> {
  if (!HEX64.test(hash)) return null;
  const res = await f(`${HORIZON}/transactions/${hash}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const t = (await res.json()) as {
    hash: string; source_account: string; fee_account?: string; created_at: string; ledger: number;
    memo_type?: string; memo?: string; successful: boolean; operation_count: number;
  };
  let ops: string[] = [];
  if (t.operation_count <= 5) {
    const o = await f(`${HORIZON}/transactions/${hash}/operations?limit=5`, { headers: { accept: 'application/json' } });
    if (!o.ok) throw new Error(`horizon ${o.status}`);
    ops = ((await o.json()) as { _embedded: { records: { type: string }[] } })._embedded.records.map((r) => r.type);
  }
  const memoHash = t.memo_type === 'hash' && t.memo ? base64ToHex(t.memo) : null;
  return {
    hash: t.hash, source: t.source_account, feeAccount: t.fee_account ?? t.source_account, at: t.created_at, ledger: t.ledger,
    memoHash: memoHash && HEX64.test(memoHash) ? memoHash : null, ops, successful: t.successful,
  };
}

/** The shape every AgentEnact seal has on chain; another transaction with a hash memo is not taken for one. */
export const isSeal = (t: ChainTx): boolean => t.successful && t.memoHash !== null && t.ops.length === 1 && t.ops[0] === 'bump_sequence';

/** The public agent whose wallet is `address`, or null. A search hit is only taken once its profile names that wallet. */
export async function agentByWallet(address: string): Promise<number | null> {
  try {
    const page = await getJson<AgentsPage>(`/public/agents?q=${encodeURIComponent(address)}&limit=5`);
    for (const a of page.items.slice(0, 5)) {
      const p = await getJson<AgentProfile>(`/public/agents/${a.id}`);
      if (p.wallet === address) return a.id;
    }
  } catch {
    /* unknown is fine: the seal stands on the chain alone */
  }
  return null;
}

/** Canonical JSON exactly as api seals/format.ts writes a seal document: sorted keys, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error('not json');
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type SealDoc = Record<string, unknown> & { v?: unknown; agent?: unknown };

export type DocMatch =
  | { ok: true; doc: SealDoc }
  | { ok: false; reason: 'not_json' | 'no_match' | 'other_agent' };

/**
 * Whether pasted text holds the document behind `memoHash`. It may be the document's exact bytes, the same document
 * reformatted (it is canonicalised back), one entry of the owner's day download, or the whole download (`{ seals: [...] }`).
 * A document that hashes right but names another agent than the transaction's source is refused.
 */
export async function matchDocument(text: string, memoHash: string, source: string): Promise<DocMatch> {
  const raw = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const candidates: string[] = [raw];
  const add = (v: unknown) => {
    if (typeof v === 'string') candidates.push(v);
    else if (v && typeof v === 'object') {
      const e = v as { document?: unknown };
      if (typeof e.document === 'string') candidates.push(e.document);
      else candidates.push(canonicalJson(v));
    }
  };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { seals?: unknown }).seals)) (parsed as { seals: unknown[] }).seals.forEach(add);
  else if (Array.isArray(parsed)) parsed.forEach(add);
  else add(parsed);
  for (const bytes of candidates) {
    if ((await sha256Hex(bytes)) !== memoHash) continue;
    let doc: SealDoc;
    try {
      doc = JSON.parse(bytes) as SealDoc;
    } catch {
      return { ok: false, reason: 'no_match' };
    }
    if (typeof doc.agent === 'string' && doc.agent !== source) return { ok: false, reason: 'other_agent' };
    return { ok: true, doc };
  }
  return { ok: false, reason: 'no_match' };
}

/** A seal document's contents as plain label/value rows, by its version. Unknown versions show their raw fields. */
export function describeDoc(doc: SealDoc): { kind: string; rows: [string, string][] } {
  const s = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
  const at: [string, string] = ['Time in the document', s(doc.at)];
  switch (doc.v) {
    case 'ae.check/1': {
      const held = doc.held === true ? 'Yes, it fired' : doc.held === false ? 'No, quiet' : 'The check failed to run';
      const reading = doc.reading && typeof doc.reading === 'object' ? Object.entries(doc.reading as Record<string, unknown>).map(([k, v]) => `${k}: ${s(v)}`).join(', ') : '—';
      return { kind: 'A condition check', rows: [at, ['Condition held', held], ['Reading', reading || '—']] };
    }
    case 'ae.decision/1': {
      const txs = Array.isArray(doc.txs) ? (doc.txs as { usdc?: unknown; network?: unknown }[]) : [];
      return {
        kind: 'A decision (one mission run)',
        rows: [
          at,
          ['Ended', s(doc.status)],
          ['Tools called', Array.isArray(doc.steps) && doc.steps.length ? (doc.steps as unknown[]).map(s).join(' → ') : 'None'],
          ['Payments it made', txs.length ? txs.map((t) => `${s(t.usdc)} USDC on ${s(t.network)}`).join(', ') : 'None'],
          ['Input hash', s(doc.input)],
          ['Answer hash', s(doc.output)],
        ],
      };
    }
    case 'ae.chat/1':
      return { kind: 'A chat conversation', rows: [at, ['Turns covered', s(doc.turns)], ['Merkle root of the turns', s(doc.root)]] };
    default:
      return { kind: typeof doc.v === 'string' ? doc.v : 'A document', rows: Object.entries(doc).filter(([k]) => k !== 'salt').map(([k, v]) => [k, s(v)]) };
  }
}
