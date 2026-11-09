/**
 * Draft handoff (P4 Task 17): a visitor's draft waits in app.draft_handoffs under an unguessable id while they sign in, then
 * the signed-in browser claims it once. The id is the only secret (16 random bytes, base64url, 22 characters). A claim is one
 * `delete ... returning`, so two racing claims give exactly one winner. Every put deletes a bounded batch of expired rows so
 * the table cleans itself without a job and without one request scanning a backlog. The draft and the id are never logged.
 * A handoff parked with an email stores only sha256(lowercase(trim(email))); a claim then needs the signed-in account's own
 * verified email to hash to the same value (a mismatch is the same null as an unknown id, and the row stays). A handoff
 * without a hash (the limit path, rows from before 0011) is claimable by any signed-in holder of the id, as before.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { checkDraft, DraftResult } from './draft-schema.js';
import { draftScopeProblem, walletProblem } from './scope.js';

export const HANDOFF_TTL_MS = 24 * 3_600_000;
/** Expired rows one put may delete. */
export const HANDOFF_SWEEP = 100;
export const HANDOFF_ID = /^[A-Za-z0-9_-]{22}$/;

export interface Handoffs {
  /** Stores a draft that already passed the Builder's checks and returns its id. Throws on a draft that does not (never stores it). */
  put(draft: DraftResult, emailSha256?: string): Promise<string>;
  /** The draft once, or null for an unknown, malformed, expired or already claimed id, or an email-bound one whose email differs. */
  claim(id: string, userEmail?: string | null): Promise<DraftResult | null>;
}

/** sha256 hex of the trimmed, lower-cased email; undefined for anything that is not a non-empty string. No plus or dot folding. */
export function emailSha256(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const e = email.trim().toLowerCase();
  return e ? createHash('sha256').update(e).digest('hex') : undefined;
}

/** A draft must pass, in this order: the DraftResult shape, the draft checks, the Builder scope. Null when it does. */
export function handoffProblem(input: unknown): { draft: DraftResult } | { problem: string } {
  const p = DraftResult.safeParse(input);
  if (!p.success) return { problem: 'the draft is not valid' };
  const problem = checkDraft(p.data) ?? draftScopeProblem(p.data) ?? walletProblem(p.data.spec);
  return problem ? { problem } : { draft: p.data };
}

export const newHandoffId = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');

export function createHandoffs(sql: Db, o: { ttlMs?: number } = {}): Handoffs {
  const ttlMs = o.ttlMs ?? HANDOFF_TTL_MS;
  return {
    async put(draft, emailHash) {
      const checked = handoffProblem(draft);
      if ('problem' in checked) throw new Error('handoff: draft refused');
      await sql`delete from app.draft_handoffs where id in (select id from app.draft_handoffs where expires_at <= now() limit ${HANDOFF_SWEEP})`;
      const id = newHandoffId();
      await sql`insert into app.draft_handoffs (id, draft, expires_at, email_sha256) values (${id}, ${checked.draft}, now() + (${ttlMs}::double precision * interval '1 millisecond'), ${emailHash ?? null})`;
      return id;
    },

    async claim(id, userEmail) {
      if (!HANDOFF_ID.test(id)) return null; // before any query
      const rows = (await sql`delete from app.draft_handoffs where id = ${id} and expires_at > now() and (email_sha256 is null or email_sha256 = ${emailSha256(userEmail) ?? null}) returning draft`) as { draft: DraftResult }[];
      return rows[0]?.draft ?? null;
    },
  };
}
