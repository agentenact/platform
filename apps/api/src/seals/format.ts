/**
 * The check seal document (`ae.check/1`): what an agent commits to on chain for one condition check. Only
 * sha256(document bytes) goes on chain, as the memo of the agent's own transaction (seals/tx.ts); the document stays
 * with the owner, because a reading can be private (a wallet balance). The random salt makes the hash hiding: nobody
 * can confirm a guessed reading against the chain.
 *
 * The bytes are canonical JSON: object keys sorted, no whitespace, JSON.stringify for every primitive. Anyone holding
 * the document checks it with `sha256sum` and the memo hash of the transaction it names. It proves the agent's key
 * committed to this check at that ledger's time. It never says the reading was right.
 *
 * Zero dependencies: the web panel imports it too.
 */

export const SEAL_VERSION = 'ae.check/1';

export type SealReading = Record<string, number | string> | null;

export interface SealDocument {
  v: typeof SEAL_VERSION;
  network: 'stellar:testnet';
  /** The agent's account (G…), the source of the sealing transaction. */
  agent: string;
  /** Its stellar-8004 id when it has one. */
  agentId: string | null;
  /** When the check ran, ISO 8601 UTC with milliseconds. */
  at: string;
  /** The condition's answer: true fired, false quiet, null the fetch or the code failed. */
  held: boolean | null;
  reading: SealReading;
  /** 32 lowercase hex characters (16 random bytes). */
  salt: string;
}

/** Canonical JSON: sorted keys, no whitespace. Rejects what JSON cannot carry exactly (undefined, NaN, functions). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('seal: a number must be finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => {
        if (o[k] === undefined) throw new Error('seal: undefined is not JSON');
        return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
      })
      .join(',')}}`;
  }
  throw new Error('seal: not JSON');
}

const G = /^G[A-Z2-7]{55}$/;
const SALT = /^[0-9a-f]{32}$/;

/** The document's bytes, checked: the shape above and nothing else. */
export function sealBytes(d: SealDocument): string {
  if (d.v !== SEAL_VERSION || d.network !== 'stellar:testnet') throw new Error('seal: wrong version or network');
  if (!G.test(d.agent) || !SALT.test(d.salt)) throw new Error('seal: bad agent or salt');
  if (d.agentId !== null && !/^\d{1,10}$/.test(d.agentId)) throw new Error('seal: bad agent id');
  if (Number.isNaN(Date.parse(d.at)) || new Date(d.at).toISOString() !== d.at) throw new Error('seal: bad time');
  if (d.held !== null && typeof d.held !== 'boolean') throw new Error('seal: bad held');
  if (d.reading !== null && (typeof d.reading !== 'object' || Array.isArray(d.reading))) throw new Error('seal: bad reading');
  for (const x of Object.values(d.reading ?? {})) if (typeof x !== 'number' && typeof x !== 'string') throw new Error('seal: bad reading');
  return canonicalJson({ v: d.v, network: d.network, agent: d.agent, agentId: d.agentId, at: d.at, held: d.held, reading: d.reading, salt: d.salt });
}

/** Parses stored bytes back; null when they are not exactly a canonical `ae.check/1` document. */
export function parseSeal(bytes: string): SealDocument | null {
  try {
    const d = JSON.parse(bytes) as SealDocument;
    return sealBytes(d) === bytes ? d : null;
  } catch {
    return null;
  }
}

/**
 * The decision seal (`ae.decision/1`): what an agent decided in one mission and what that produced, committed on
 * Stellar like a check. It binds the hash of the mission's input (the readings and the instruction that started it),
 * the tools it called in order, the hash of its answer, and every transaction the run paid with, on whichever chain
 * (`txs`). Sealed when the run ends: it proves this decision produced those transactions, not that it came first.
 */
export const DECISION_VERSION = 'ae.decision/1';
export const DECISION_MAX_STEPS = 40;
export const DECISION_MAX_TXS = 12;

export interface DecisionTx {
  /** CAIP-2: stellar:testnet, eip155:84532, … */
  network: string;
  /** 64 lowercase hex characters (an EVM hash without 0x, as the ledger stores it). */
  tx: string;
  /** The amount paid, as a decimal string, in USDC. */
  usdc: string;
  to: string;
}

export interface DecisionDocument {
  v: typeof DECISION_VERSION;
  network: 'stellar:testnet';
  agent: string;
  agentId: string | null;
  at: string;
  runId: string;
  /** How the run ended: done, error, budget. */
  status: string;
  /** sha256 of the mission's input text. */
  input: string;
  /** sha256 of its answer; null when it gave none. */
  output: string | null;
  /** Tool names, in the order they were called. */
  steps: string[];
  txs: DecisionTx[];
  salt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function decisionBytes(d: DecisionDocument): string {
  if (d.v !== DECISION_VERSION || d.network !== 'stellar:testnet') throw new Error('seal: wrong version or network');
  if (!G.test(d.agent) || !SALT.test(d.salt) || !UUID.test(d.runId)) throw new Error('seal: bad agent, run or salt');
  if (d.agentId !== null && !/^\d{1,10}$/.test(d.agentId)) throw new Error('seal: bad agent id');
  if (Number.isNaN(Date.parse(d.at)) || new Date(d.at).toISOString() !== d.at) throw new Error('seal: bad time');
  if (!/^[a-z_]{1,20}$/.test(d.status) || !HEX64.test(d.input) || (d.output !== null && !HEX64.test(d.output))) throw new Error('seal: bad status or hashes');
  if (d.steps.length > DECISION_MAX_STEPS || !d.steps.every((s) => /^[a-z0-9_]{1,64}$/.test(s))) throw new Error('seal: bad steps');
  if (d.txs.length > DECISION_MAX_TXS) throw new Error('seal: too many transactions');
  for (const t of d.txs) {
    if (!/^(stellar:testnet|eip155:\d{1,12})$/.test(t.network) || !HEX64.test(t.tx) || !/^\d{1,15}(\.\d{1,8})?$/.test(t.usdc) || !/^(G[A-Z2-7]{55}|0x[0-9a-f]{40})$/.test(t.to)) {
      throw new Error('seal: bad transaction');
    }
  }
  return canonicalJson({
    v: d.v, network: d.network, agent: d.agent, agentId: d.agentId, at: d.at, runId: d.runId, status: d.status,
    input: d.input, output: d.output, steps: d.steps, txs: d.txs.map((t) => ({ network: t.network, tx: t.tx, usdc: t.usdc, to: t.to })), salt: d.salt,
  });
}

export function parseDecision(bytes: string): DecisionDocument | null {
  try {
    const d = JSON.parse(bytes) as DecisionDocument;
    return decisionBytes(d) === bytes ? d : null;
  } catch {
    return null;
  }
}

/**
 * Chat seals. Each owner chat turn is a leaf (`ae.chat-turn/1`): the hashes of the question and the answer, the tools
 * it called, its run, and its own salt, so a short question ("hi") cannot be confirmed by guessing. The leaves of one
 * conversation form an RFC 6962 Merkle tree, and the conversation's seal (`ae.chat/1`) puts its root on chain. A root is
 * sealed when the conversation goes quiet or the owner starts a new one; a conversation that goes on later gets another
 * seal over all its turns so far (`turns` says how many the root covers). One leaf and its audit path prove one turn
 * without showing any other. A turn that paid is also sealed at once as an `ae.decision/1` of its run.
 *
 * Per conversation, not per message: a transaction per message would publish when the owner talks to the agent.
 */
export const CHAT_TURN_VERSION = 'ae.chat-turn/1';
export const CHAT_VERSION = 'ae.chat/1';

export interface ChatTurnLeaf {
  v: typeof CHAT_TURN_VERSION;
  /** The conversation (app.chat_sessions.id). */
  session: string;
  /** 1-based position in the conversation. */
  seq: number;
  at: string;
  /** The run behind the answer; null when the turn was refused before a run started. */
  runId: string | null;
  status: string;
  input: string;
  output: string | null;
  steps: string[];
  salt: string;
}

export function chatTurnBytes(l: ChatTurnLeaf): string {
  if (l.v !== CHAT_TURN_VERSION || !UUID.test(l.session) || (l.runId !== null && !UUID.test(l.runId)) || !SALT.test(l.salt)) throw new Error('seal: bad chat turn');
  if (!Number.isInteger(l.seq) || l.seq < 1 || l.seq > 1_000_000) throw new Error('seal: bad seq');
  if (Number.isNaN(Date.parse(l.at)) || new Date(l.at).toISOString() !== l.at) throw new Error('seal: bad time');
  if (!/^[a-z_]{1,20}$/.test(l.status) || !HEX64.test(l.input) || (l.output !== null && !HEX64.test(l.output))) throw new Error('seal: bad status or hashes');
  if (l.steps.length > DECISION_MAX_STEPS || !l.steps.every((s) => /^[a-z0-9_]{1,64}$/.test(s))) throw new Error('seal: bad steps');
  return canonicalJson({ v: l.v, session: l.session, seq: l.seq, at: l.at, runId: l.runId, status: l.status, input: l.input, output: l.output, steps: l.steps, salt: l.salt });
}

export function parseChatTurn(bytes: string): ChatTurnLeaf | null {
  try {
    const l = JSON.parse(bytes) as ChatTurnLeaf;
    return chatTurnBytes(l) === bytes ? l : null;
  } catch {
    return null;
  }
}

export interface ChatDocument {
  v: typeof CHAT_VERSION;
  network: 'stellar:testnet';
  agent: string;
  agentId: string | null;
  at: string;
  session: string;
  /** How many turns (leaves 1..turns) the root covers. */
  turns: number;
  /** RFC 6962 Merkle tree hash of the turns' leaf bytes, 64 lowercase hex. */
  root: string;
}

export function chatBytes(d: ChatDocument): string {
  if (d.v !== CHAT_VERSION || d.network !== 'stellar:testnet') throw new Error('seal: wrong version or network');
  if (!G.test(d.agent) || !UUID.test(d.session) || !HEX64.test(d.root)) throw new Error('seal: bad agent, session or root');
  if (d.agentId !== null && !/^\d{1,10}$/.test(d.agentId)) throw new Error('seal: bad agent id');
  if (Number.isNaN(Date.parse(d.at)) || new Date(d.at).toISOString() !== d.at) throw new Error('seal: bad time');
  if (!Number.isInteger(d.turns) || d.turns < 1 || d.turns > 1_000_000) throw new Error('seal: bad turns');
  return canonicalJson({ v: d.v, network: d.network, agent: d.agent, agentId: d.agentId, at: d.at, session: d.session, turns: d.turns, root: d.root });
}

export function parseChat(bytes: string): ChatDocument | null {
  try {
    const d = JSON.parse(bytes) as ChatDocument;
    return chatBytes(d) === bytes ? d : null;
  } catch {
    return null;
  }
}
