/**
 * `seals`: every condition check sealed on chain (Kerem, 2026-10-29). The scheduler's check log hands each check to
 * `enqueue`, which writes its `ae.check/1` document (format.ts) and digest as a pending row and returns at once: a
 * check never waits on the chain. The worker (`tick`) lands pending rows, oldest first:
 *
 *   agent account read → inner seal tx (tx.ts) → vault signs as the agent → sponsor fee-bump (none for a self-paying agent) → vault signs as the
 *   sponsor → Horizon submit (synchronous: answers once the ledger closes) → row 'sent' with its tx hash
 *
 * One agent's seals go one at a time (they share its sequence); different agents go side by side, up to
 * AGENT_PARALLEL. A failure retries with a growing wait; after MAX_ATTEMPTS the row is 'failed' and stays visible as
 * such. The kill switch pauses the worker; the queue keeps filling and drains when it is lifted.
 *
 * A finished mission queues one decision seal the same way (`enqueueDecision`, format.ts `ae.decision/1`): the
 * worker does not tell the kinds apart, both are a digest the agent puts on chain.
 *
 * Owner chat conversations (chat/sessions.ts) are sealed per conversation, not per message: each tick first queues an
 * `ae.chat/1` seal (the Merkle root of its turns' leaves) for every conversation that has unsealed turns and either went
 * quiet for CHAT_QUIET_S or was left for a new one. A chat turn that paid is sealed at once as a decision of its run.
 */
import { randomBytes } from 'node:crypto';
import type { Account } from '@stellar/stellar-sdk';
import type { Db } from '../db/index.js';
import { TESTNET } from '../owner-client/testnet.js';
import { CHAT_VERSION, DECISION_MAX_STEPS, DECISION_MAX_TXS, DECISION_VERSION, SEAL_VERSION, chatBytes, decisionBytes, sealBytes, type DecisionTx, type SealReading } from './format.js';
import { merkleRoot } from './merkle.js';
import { buildSealTx, feeBumpSeal } from './tx.js';

/** Rows claimed per tick. A tick every TICK_MS, so the worker's ceiling is well above a check per agent per 5 minutes. */
export const CLAIM_BATCH = 40;
export const TICK_MS = 3_000;
/** Agents sealed side by side within a tick. */
export const AGENT_PARALLEL = 4;
/** A claimed row is hidden from other ticks this long (a crashed tick's rows come back after it). */
export const CLAIM_LEASE_S = 120;
export const MAX_ATTEMPTS = 8;
/** Seconds before retry n (1-based): 10, 20, 40, … capped at 15 minutes. */
export const retryDelayS = (n: number) => Math.min(10 * 2 ** (n - 1), 900);
/** A conversation with no new turn for this long is sealed. */
export const CHAT_QUIET_S = 600;
/** Conversations sealed per tick. */
export const CHAT_BATCH = 20;

/** An ed25519 signature in base64: 64 bytes, 88 characters with padding. */
export const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

export interface SealChain {
  sponsorPublicKey: string;
  getAccount(id: string): Promise<Account>;
  /** The sponsor's signature on a seal fee-bump (the vault's, behind its policy). */
  signSponsor(txXdr: string, passphrase: string): Promise<string>;
  /** Submits and waits for the ledger; throws on anything but success. */
  submit(txXdr: string): Promise<{ hash: string }>;
  /**
   * The source key's signature on a sent transaction (the inner one of a fee-bump), base64 as Horizon serves it; null
   * when Horizon no longer has the transaction. Absent: older seals are never back-filled.
   */
  txSignature?(hash: string): Promise<string | null>;
}

export interface SealCheck {
  held: boolean | null;
  reading: SealReading;
  /** When the check ran; defaults to now. */
  at?: Date;
}

export interface DaySeals {
  /** YYYY-MM-DD, UTC. */
  day: string;
  total: number;
  sent: number;
  failed: number;
  /** The newest landed seal of the day. */
  last: { hash: string; at: string } | null;
}

export interface SealDecision {
  runId: string;
  /** How the run ended. */
  status: string;
  /** The mission's input text and its answer: only their sha256 goes into the document. */
  input: string;
  output: string;
}

export interface SealRow {
  kind: 'check' | 'decision' | 'chat' | 'chat_turn';
  /** The run a decision seal belongs to; null for a check or a chat. */
  runId: string | null;
  /** The conversation a chat seal belongs to, and how many of its turns the root covers (chat_turn: which turn). */
  sessionId?: string | null;
  turns?: number | null;
  at: string;
  status: 'pending' | 'sent' | 'failed';
  digest: string;
  tx: string | null;
  document: string;
}

export interface Seals {
  /** Writes the check's pending seal. Never throws for a reason the caller could act on: it logs and returns. */
  enqueue(agentId: string, c: SealCheck): Promise<void>;
  /**
   * Writes a finished mission's decision seal: its input and answer hashes, the tools it called, and every payment it
   * settled (any chain). Once per run. Never throws, like `enqueue`.
   */
  enqueueDecision(agentId: string, d: SealDecision): Promise<void>;
  /**
   * Queues an `ae.chat/1` seal for each conversation that is due (quiet for CHAT_QUIET_S, or left for a new one).
   * Runs at the start of every tick; also callable alone. Returns how many it queued.
   */
  sweepChats(): Promise<number>;
  /** The decision seal of each of these runs that has one. */
  decisions(agentId: string, runIds: string[]): Promise<Map<string, { status: SealRow['status']; tx: string | null }>>;
  /** Lands what is due. Returns how many rows it sent and how many failed for good. */
  tick(): Promise<{ sent: number; retried: number; failed: number }>;
  start(intervalMs?: number): () => void;
  inflight(): Promise<unknown>[];
  /** Per UTC day on or after `since` (newest first), how many checks were sealed. */
  days(agentId: string, since: Date): Promise<DaySeals[]>;
  /** One UTC day's seals with their documents, oldest first (the owner's download). */
  day(agentId: string, day: string): Promise<SealRow[]>;
  /** The transaction of the sent seal with this signature (base64), or null. Public: a signature names no secret. */
  bySignature(signature: string): Promise<string | null>;
}

interface Claimed {
  id: string;
  agent_id: string;
  digest: string;
  attempts: number;
  address: string | null;
  /** The agent pays its own fees (FEE_MODEL=agent, agents/reserve.ts): its seal goes out unbumped. */
  pays_own_fees: boolean;
}

const errorCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : '';
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string') return `vault_${reason}`.slice(0, 60);
  if (/tx_bad_seq/.test(m)) return 'bad_seq';
  if (/tx_insufficient_balance/.test(m)) return 'no_xlm';
  if (/Horizon submit failed/.test(m)) return `horizon_${(/failed: (\d{3})/.exec(m)?.[1] ?? 'error')}`;
  if (/sponsor refuses|above cap/.test(m)) return 'sponsor_refused';
  return 'error';
};

export function createSeals(d: {
  sql: Db;
  chain: SealChain;
  signSeal: (agentId: string, txXdr: string, passphrase: string) => Promise<string>;
  killed: () => boolean;
  log: (e: Record<string, unknown>) => void;
  now?: () => Date;
  salt?: () => string;
}): Seals {
  const { sql, chain, log } = d;
  const now = d.now ?? (() => new Date());
  const salt = d.salt ?? (() => randomBytes(16).toString('hex'));
  const passphrase = TESTNET.passphrase;
  let current: Promise<unknown> | null = null;

  async function sealOne(row: Claimed, account: Account): Promise<{ hash: string; sig: string }> {
    const inner = buildSealTx(account, row.digest, passphrase);
    const sig = await d.signSeal(row.agent_id, inner.toXDR(), passphrase);
    inner.addSignature(row.address!, sig);
    if (row.pays_own_fees) return { hash: (await chain.submit(inner.toXDR())).hash, sig };
    const bumped = feeBumpSeal(inner, chain.sponsorPublicKey, passphrase);
    const signed = await chain.signSponsor(bumped.toXDR(), passphrase);
    return { hash: (await chain.submit(signed)).hash, sig };
  }

  /** Fills the signature of one older sent seal from Horizon; the next tick takes the next. Never throws. */
  async function backfillOne(): Promise<void> {
    if (!chain.txSignature) return;
    try {
      const rows = (await sql`select id::text as id, tx_hash from app.check_seals
                              where status = 'sent' and signature is null and tx_hash is not null order by id desc limit 1`) as { id: string; tx_hash: string }[];
      const r = rows[0];
      if (!r) return;
      const sig = await chain.txSignature(r.tx_hash);
      await sql`update app.check_seals set signature = ${sig ?? ''} where id = ${r.id} and signature is null`;
    } catch {
      /* Horizon busy or down: the same row is tried next tick */
    }
  }

  async function sealAgent(rows: Claimed[]): Promise<{ sent: number; retried: number; failed: number }> {
    const out = { sent: 0, retried: 0, failed: 0 };
    let account: Account | null = null;
    for (const row of rows) {
      try {
        if (!row.address) throw new Error('no_address');
        // One read per agent per tick; each built tx moves the local copy's sequence on by one.
        account ??= await chain.getAccount(row.address);
        const { hash, sig } = await sealOne(row, account);
        await sql`update app.check_seals set status = 'sent', tx_hash = ${hash}, signature = ${sig}, sent_at = now(), error = null where id = ${row.id}`;
        out.sent++;
      } catch (e) {
        // The sequence may have moved (or not): read it again for the next row.
        account = null;
        const code = errorCode(e);
        // A self-paying agent out of XLM: the reserve worker buys it a float with its own USDC, and this seal retries.
        if (code === 'no_xlm' && row.pays_own_fees) {
          await sql`update app.agents set reserve_next_at = now() where id = ${row.agent_id} and pays_own_fees and reserve_next_at is null`;
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await sql`update app.check_seals set status = 'failed', attempts = ${attempts}, error = ${code} where id = ${row.id}`;
          out.failed++;
          log({ event: 'seal_failed', agent: row.agent_id, error: code });
        } else {
          await sql`update app.check_seals set attempts = ${attempts}, error = ${code},
                      next_at = now() + make_interval(secs => ${retryDelayS(attempts)}) where id = ${row.id}`;
          out.retried++;
        }
      }
    }
    return out;
  }

  async function sweepChats(): Promise<number> {
    let queued = 0;
    const due = (await sql`select s.id, s.agent_id, s.turns from app.chat_sessions s join app.agents a on a.id = s.agent_id
                           where s.turns > s.sealed_turns and a.stellar_address is not null and a.status <> 'revoked'
                             and (s.seal_due or s.updated_at < now() - make_interval(secs => ${CHAT_QUIET_S}))
                           order by s.updated_at limit ${CHAT_BATCH}`) as { id: string; agent_id: string; turns: number }[];
    for (const c of due) {
      try {
        const id = await identity(c.agent_id);
        if (!id) continue;
        const leaves = (await sql`select leaf from app.chat_turns where session_id = ${c.id} and seq <= ${c.turns} order by seq`) as { leaf: string }[];
        if (leaves.length !== c.turns) continue; // a turn is still being written: next tick
        const at = now();
        const doc = chatBytes({ v: CHAT_VERSION, network: 'stellar:testnet', ...id, at: at.toISOString(), session: c.id, turns: c.turns, root: merkleRoot(leaves.map((l) => l.leaf)) });
        await sql.begin(async (tx) => {
          await tx`insert into app.check_seals (agent_id, kind, session_id, turns, check_at, document, digest)
                   values (${c.agent_id}, 'chat', ${c.id}, ${c.turns}, ${at}, ${doc}, ${sha256(doc)}) on conflict do nothing`;
          await tx`update app.chat_sessions set sealed_turns = greatest(sealed_turns, ${c.turns}), seal_due = false where id = ${c.id}`;
        });
        queued++;
      } catch {
        log({ event: 'seal_enqueue_failed', agent: c.agent_id, kind: 'chat' });
      }
    }
    return queued;
  }

  async function tick() {
    const total = { sent: 0, retried: 0, failed: 0 };
    if (d.killed()) return total;
    try {
      await sweepChats();
    } catch {
      log({ event: 'chat_sweep_failed' });
    }
    const rows = (await sql`with due as (
                              select id from app.check_seals where status = 'pending' and next_at <= now()
                              order by next_at, id limit ${CLAIM_BATCH} for update skip locked)
                            update app.check_seals s set next_at = now() + make_interval(secs => ${CLAIM_LEASE_S})
                            from due, app.agents a
                            where s.id = due.id and a.id = s.agent_id
                            returning s.id::text as id, s.agent_id, s.digest, s.attempts, a.stellar_address as address, a.pays_own_fees, s.check_at`) as (Claimed & { check_at: Date })[];
    // Per agent, oldest check first: its seals share one sequence.
    const byAgent = new Map<string, Claimed[]>();
    for (const r of rows.sort((x, y) => x.check_at.getTime() - y.check_at.getTime() || Number(x.id) - Number(y.id))) {
      byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
    }
    await backfillOne();
    const groups = [...byAgent.values()];
    for (let i = 0; i < groups.length; i += AGENT_PARALLEL) {
      for (const r of await Promise.all(groups.slice(i, i + AGENT_PARALLEL).map(sealAgent))) {
        total.sent += r.sent;
        total.retried += r.retried;
        total.failed += r.failed;
      }
    }
    return total;
  }

  const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

  /** The agent's account and on-chain id, or null before it has an account (nothing could sign). */
  async function identity(agentId: string): Promise<{ agent: string; agentId: string | null } | null> {
    const rows = (await sql`select stellar_address, agent_id from app.agents where id = ${agentId}`) as { stellar_address: string | null; agent_id: string | null }[];
    const a = rows[0];
    if (!a?.stellar_address) return null;
    return { agent: a.stellar_address, agentId: a.agent_id !== null && /^\d{1,10}$/.test(String(a.agent_id)) ? String(a.agent_id) : null };
  }

  return {
    async enqueueDecision(agentId, dd) {
      try {
        const id = await identity(agentId);
        if (!id) return;
        const [run] = (await sql`select steps from app.runs where id = ${dd.runId} and agent_id = ${agentId}`) as { steps: { tools?: unknown }[] }[];
        if (!run) return;
        const steps = (Array.isArray(run.steps) ? run.steps : [])
          .flatMap((s) => (Array.isArray(s?.tools) ? s.tools : []))
          .filter((t): t is string => typeof t === 'string' && /^[a-z0-9_]{1,64}$/.test(t))
          .slice(0, DECISION_MAX_STEPS);
        const paid = (await sql`select network, tx_hash, amount_usdc::text as usdc, payee from app.spend
                                where agent_id = ${agentId} and run_id = ${dd.runId} and decision = 'settled' and tx_hash is not null
                                order by created_at limit ${DECISION_MAX_TXS}`) as { network: string; tx_hash: string; usdc: string; payee: string }[];
        const txs: DecisionTx[] = paid.map((p) => ({ network: p.network, tx: p.tx_hash, usdc: p.usdc, to: p.payee }));
        const at = now();
        const doc = decisionBytes({
          v: DECISION_VERSION,
          network: 'stellar:testnet',
          ...id,
          at: at.toISOString(),
          runId: dd.runId,
          status: dd.status,
          input: sha256(dd.input),
          output: dd.output.trim() ? sha256(dd.output) : null,
          steps,
          txs,
          salt: salt(),
        });
        await sql`insert into app.check_seals (agent_id, kind, run_id, check_at, document, digest)
                  values (${agentId}, 'decision', ${dd.runId}, ${at}, ${doc}, ${sha256(doc)}) on conflict do nothing`;
      } catch {
        log({ event: 'seal_enqueue_failed', agent: agentId, kind: 'decision' });
      }
    },

    async decisions(agentId, runIds) {
      const out = new Map<string, { status: SealRow['status']; tx: string | null }>();
      if (runIds.length === 0) return out;
      const rows = (await sql`select run_id, status, tx_hash from app.check_seals
                              where agent_id = ${agentId} and kind = 'decision' and run_id = any(${`{${runIds.join(',')}}`}::uuid[])`) as { run_id: string; status: SealRow['status']; tx_hash: string | null }[];
      for (const r of rows) out.set(r.run_id, { status: r.status, tx: r.tx_hash });
      return out;
    },

    async enqueue(agentId, c) {
      try {
        const id = await identity(agentId);
        if (!id) return; // not born yet: nothing can sign
        const at = c.at ?? now();
        const doc = sealBytes({
          v: SEAL_VERSION,
          network: 'stellar:testnet',
          ...id,
          at: at.toISOString(),
          held: c.held,
          reading: c.reading,
          salt: salt(),
        });
        await sql`insert into app.check_seals (agent_id, check_at, document, digest) values (${agentId}, ${at}, ${doc}, ${sha256(doc)})`;
      } catch {
        log({ event: 'seal_enqueue_failed', agent: agentId });
      }
    },

    tick,
    sweepChats,

    start(intervalMs = TICK_MS) {
      let stopped = false;
      const timer = setInterval(() => {
        if (stopped || current) return;
        current = tick()
          .then((r) => {
            if (r.sent + r.retried + r.failed > 0) log({ event: 'seals_tick', ...r });
          })
          .catch(() => log({ event: 'seals_tick_failed' }))
          .finally(() => {
            current = null;
          });
      }, intervalMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },

    inflight: () => (current ? [current] : []),

    async days(agentId, since) {
      const rows = (await sql`select to_char((check_at at time zone 'utc')::date, 'YYYY-MM-DD') as day, count(*)::int as total,
                                     count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
                                     (array_agg(tx_hash order by check_at desc) filter (where status = 'sent'))[1] as last_hash,
                                     max(check_at) filter (where status = 'sent') as last_at
                              from app.check_seals
                              where agent_id = ${agentId} and kind = 'check' and check_at >= date_trunc('day', ${since}::timestamptz, 'UTC')
                              group by 1 order by 1 desc`) as { day: string; total: number; sent: number; failed: number; last_hash: string | null; last_at: Date | null }[];
      return rows.map((r) => ({ day: r.day, total: r.total, sent: r.sent, failed: r.failed, last: r.last_hash && r.last_at ? { hash: r.last_hash, at: r.last_at.toISOString() } : null }));
    },

    async bySignature(signature) {
      if (!SIGNATURE.test(signature)) return null;
      const rows = (await sql`select tx_hash from app.check_seals where signature = ${signature} and status = 'sent' and tx_hash is not null limit 1`) as { tx_hash: string }[];
      return rows[0]?.tx_hash ?? null;
    },
    async day(agentId, day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
      const rows = (await sql`select kind, run_id, session_id, turns, check_at, status, digest, tx_hash, document from app.check_seals
                              where agent_id = ${agentId} and check_at >= ${day}::date::timestamp at time zone 'UTC'
                                and check_at < (${day}::date + 1)::timestamp at time zone 'UTC'
                              order by check_at, id`) as { kind: SealRow['kind']; run_id: string | null; session_id: string | null; turns: number | null; check_at: Date; status: SealRow['status']; digest: string; tx_hash: string | null; document: string }[];
      return rows.map((r) => ({
        kind: r.kind, runId: r.run_id, ...(r.kind === 'chat' || r.kind === 'chat_turn' ? { sessionId: r.session_id, turns: r.turns } : {}),
        at: r.check_at.toISOString(), status: r.status, digest: r.digest, tx: r.tx_hash, document: r.document,
      }));
    },
  };
}

/** The live chain side: Horizon for the account and the submit, the vault (through `chain.sponsor`) for the fee-bump. */
export function sealChainOver(
  c: { sponsorPublicKey: string; sponsor: { signTransaction(x: string, p: string): Promise<string> }; soroban: { getAccount(id: string): Promise<Account> }; horizonSubmit(x: string): Promise<{ hash: string }> },
  doFetch: typeof fetch = fetch,
): SealChain {
  return {
    sponsorPublicKey: c.sponsorPublicKey,
    getAccount: (id) => c.soroban.getAccount(id),
    signSponsor: (x, p) => c.sponsor.signTransaction(x, p),
    submit: (x) => c.horizonSubmit(x),
    txSignature: async (hash) => {
      const res = await doFetch(`${TESTNET.horizonUrl}/transactions/${hash}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`horizon ${res.status}`);
      const t = (await res.json()) as { signatures?: string[]; inner_transaction?: { signatures?: string[] } };
      return (t.inner_transaction?.signatures ?? t.signatures ?? [])[0] ?? null;
    },
  };
}
