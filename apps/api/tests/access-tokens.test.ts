import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAccessTokens, MAX_LIVE_TOKENS, TOKEN_TTL_DAYS } from '../src/account/access-tokens.js';
import type { Db } from '../src/db/index.js';
import { freshDb, MIGRATIONS_DIR } from './support/db.js';
import { activeAgent } from './support/specs.js';

describe('access tokens', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  it('issues a token once, stores only its sha256, and verifies it for its user', async () => {
    const { userId } = await activeAgent(sql);
    const t = createAccessTokens(sql);
    const issued = await t.issue(userId, '  Claude Code on my laptop ');
    expect(issued.token).toMatch(/^ae_pat_[A-Za-z0-9_-]{43}$/);
    expect(issued.name).toBe('Claude Code on my laptop');
    expect(issued.hint).toBe(issued.token.slice(0, 11));
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.createdAt)).toBe(TOKEN_TTL_DAYS * 86_400_000);
    const stored = (await sql`select token_sha256 from app.access_tokens where id = ${issued.id}`) as { token_sha256: string }[];
    expect(stored[0]!.token_sha256).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(JSON.stringify(await t.list(userId))).not.toContain(issued.token);
    expect(await t.verify(issued.token)).toEqual({ userId, tokenId: issued.id });
  });

  it('refuses anything that is not a live token, without throwing', async () => {
    const { userId } = await activeAgent(sql);
    let clock = Date.parse('2026-10-28T10:00:00Z');
    const t = createAccessTokens(sql, { now: () => clock });
    const a = await t.issue(userId, 'a');
    expect(await t.verify('')).toBeNull();
    expect(await t.verify('Bearer x')).toBeNull();
    expect(await t.verify(`ae_pat_${'A'.repeat(43)}`)).toBeNull();
    expect(await t.verify(`${a.token}x`)).toBeNull();
    clock += TOKEN_TTL_DAYS * 86_400_000 + 1;
    expect(await t.verify(a.token)).toBeNull();
    expect(await t.list(userId)).toEqual([]);
  });

  it('revokes only the owner\'s own token, once', async () => {
    const owner = await activeAgent(sql);
    const other = await activeAgent(sql);
    const t = createAccessTokens(sql);
    const a = await t.issue(owner.userId, 'a');
    await expect(t.revoke(other.userId, a.id)).rejects.toMatchObject({ status: 404 });
    expect(await t.verify(a.token)).not.toBeNull();
    await t.revoke(owner.userId, a.id);
    expect(await t.verify(a.token)).toBeNull();
    await expect(t.revoke(owner.userId, a.id)).rejects.toMatchObject({ status: 404 });
  });

  it('caps live tokens per account, and a revoked one frees a slot', async () => {
    const { userId } = await activeAgent(sql);
    const t = createAccessTokens(sql);
    const made = await Promise.all(Array.from({ length: MAX_LIVE_TOKENS + 3 }, (_, i) => t.issue(userId, `t${i}`).catch((e) => e)));
    expect(made.filter((m) => m instanceof Error)).toHaveLength(3);
    expect(made.find((m) => m instanceof Error)).toMatchObject({ status: 409, code: 'too_many_tokens' });
    const first = made.find((m) => !(m instanceof Error)) as { id: string };
    await t.revoke(userId, first.id);
    await t.issue(userId, 'again');
    expect(await t.list(userId)).toHaveLength(MAX_LIVE_TOKENS);
  });

  it('rejects a bad name before writing anything', async () => {
    const { userId } = await activeAgent(sql);
    const t = createAccessTokens(sql);
    await expect(t.issue(userId, '   ')).rejects.toMatchObject({ status: 400, code: 'bad_name' });
    await expect(t.issue(userId, 'x'.repeat(65))).rejects.toMatchObject({ status: 400 });
    expect(await t.list(userId)).toEqual([]);
  });

  it('migration 0023 re-applies cleanly and keeps rows', async () => {
    const { userId } = await activeAgent(sql);
    const t = createAccessTokens(sql);
    const a = await t.issue(userId, 'kept');
    const text = await Bun.file(`${MIGRATIONS_DIR}0023_access_tokens.sql`).text();
    await sql.unsafe(text);
    await sql.unsafe(text);
    expect(await t.verify(a.token)).not.toBeNull();
  });
});
