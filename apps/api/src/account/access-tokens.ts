/**
 * Access tokens for the owner MCP server (`POST /mcp`, owner-mcp/). A harness (Claude Code, Codex, Hermes) cannot hold
 * the panel's short-lived Supabase session, so the owner makes a token in the panel: shown once, valid TOKEN_TTL_DAYS,
 * revocable. Only its sha256 is stored (migration 0023). A token reaches the owner MCP tools and nothing else: the panel
 * routes keep verifying Supabase sessions, and an `ae_pat_` value is never a session.
 *
 * Shape: `ae_pat_` + 32 random bytes base64url (43 chars). The prefix lets a leaked token be recognised in logs and
 * secret scanners; it carries no data.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';

export const TOKEN_PREFIX = 'ae_pat_';
export const TOKEN_TTL_DAYS = 90;
/** Live (not revoked, not expired) tokens one account may hold. */
export const MAX_LIVE_TOKENS = 10;
const TOKEN = /^ae_pat_[A-Za-z0-9_-]{43}$/;
/** last_used_at is written at most this often per token, so a busy harness does not churn the row. */
const TOUCH_EVERY_MS = 60_000;

export interface AccessTokenView {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface AccessTokens {
  /** Returns the token once; it is never readable again. 409 too_many_tokens past MAX_LIVE_TOKENS. */
  issue(userId: string, name: string): Promise<AccessTokenView & { token: string }>;
  /** Live tokens, newest first. */
  list(userId: string): Promise<AccessTokenView[]>;
  /** Revokes one of the user's own tokens. Unknown, foreign or already revoked: 404. */
  revoke(userId: string, id: string): Promise<void>;
  /** The user a token acts for, or null for anything that is not a live token. Never throws for a bad token. */
  verify(token: string): Promise<{ userId: string; tokenId: string } | null>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const isAccessToken = (s: string) => s.startsWith(TOKEN_PREFIX);

interface Row {
  id: string;
  name: string;
  hint: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
}
const view = (r: Row): AccessTokenView => ({
  id: r.id,
  name: r.name,
  hint: r.hint,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
});

export function createAccessTokens(sql: Db, o: { now?: () => number } = {}): AccessTokens {
  const now = o.now ?? Date.now;
  const touched = new Map<string, number>();

  return {
    async issue(userId, rawName) {
      const name = rawName.trim();
      if (name.length < 1 || name.length > 64) throw httpError(400, 'bad_name');
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const created = new Date(now());
      const expires = new Date(created.getTime() + TOKEN_TTL_DAYS * 86_400_000);
      // Count and insert in one transaction, under a lock on the user's row, so two tabs cannot both pass the cap.
      const row = await sql.begin(async (tx) => {
        await tx`select 1 from app.users where id = ${userId} for update`;
        const counted = (await tx`select count(*)::int as n from app.access_tokens
                                  where user_id = ${userId} and revoked_at is null and expires_at > ${created}`) as { n: number }[];
        if ((counted[0]?.n ?? 0) >= MAX_LIVE_TOKENS) throw httpError(409, 'too_many_tokens');
        const rows = (await tx`insert into app.access_tokens (user_id, name, token_sha256, hint, created_at, expires_at)
                               values (${userId}, ${name}, ${sha256(token)}, ${token.slice(0, TOKEN_PREFIX.length + 4)}, ${created}, ${expires})
                               returning id, name, hint, created_at, expires_at, last_used_at`) as Row[];
        return rows[0]!;
      });
      return { ...view(row), token };
    },

    async list(userId) {
      const rows = (await sql`select id, name, hint, created_at, expires_at, last_used_at from app.access_tokens
                              where user_id = ${userId} and revoked_at is null and expires_at > ${new Date(now())}
                              order by created_at desc`) as Row[];
      return rows.map(view);
    },

    async revoke(userId, id) {
      const rows = (await sql`update app.access_tokens set revoked_at = ${new Date(now())}
                              where id = ${id} and user_id = ${userId} and revoked_at is null returning id`) as { id: string }[];
      if (!rows[0]) throw httpError(404, 'not_found');
      touched.delete(id);
    },

    async verify(token) {
      if (!TOKEN.test(token)) return null;
      const at = new Date(now());
      const rows = (await sql`select id, user_id from app.access_tokens
                              where token_sha256 = ${sha256(token)} and revoked_at is null and expires_at > ${at}`) as { id: string; user_id: string }[];
      const r = rows[0];
      if (!r) return null;
      const last = touched.get(r.id) ?? 0;
      if (at.getTime() - last >= TOUCH_EVERY_MS) {
        touched.set(r.id, at.getTime());
        await sql`update app.access_tokens set last_used_at = ${at} where id = ${r.id}`;
      }
      return { userId: r.user_id, tokenId: r.id };
    },
  };
}
