import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import {
  ANON_DRAFTS_GLOBAL,
  ANON_DRAFTS_PER_IP,
  ANON_EDITS_PER_IP,
  ANON_TRIALS_GLOBAL,
  ANON_TRIALS_PER_IP,
  createBuilderLimits,
  HANDOFFS_PER_IP,
  USER_DRAFTS,
  USER_DRAFTS_GLOBAL,
  USER_TRIALS,
} from '../src/builder/limits.js';
import { freshDb } from './support/db.js';

describe('builder limits (D5)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  let n = 0;
  /** A distinct documentation-range address per test, so buckets never overlap. */
  const ip = () => `198.51.${100 + Math.floor(++n / 250)}.${n % 250}`;
  const reset = () => sql`delete from app.builder_usage`;

  it('the D5 numbers', () => {
    expect([ANON_DRAFTS_PER_IP, ANON_TRIALS_PER_IP, ANON_EDITS_PER_IP, ANON_DRAFTS_GLOBAL, ANON_TRIALS_GLOBAL, USER_DRAFTS, USER_TRIALS, HANDOFFS_PER_IP]).toEqual([3, 1, 20, 300, 100, 10, 10, 10]);
  });

  it('the fourth anonymous draft from one IP is refused with sign_in', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const who = { ip: ip() };
    for (let i = 0; i < 3; i++) expect(await l.admit(who, 'draft')).toEqual({ ok: true });
    expect(await l.admit(who, 'draft')).toEqual({ ok: false, reason: 'sign_in' });
    expect(await l.admit({ ip: ip() }, 'draft')).toEqual({ ok: true }); // another visitor is unaffected
  });

  it('one trial per IP, 20 edits per IP, 10 handoffs per IP', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const who = { ip: ip() };
    expect(await l.admit(who, 'trial')).toEqual({ ok: true });
    expect(await l.admit(who, 'trial')).toEqual({ ok: false, reason: 'sign_in' });
    for (let i = 0; i < 20; i++) expect(await l.admit(who, 'edit')).toEqual({ ok: true });
    expect(await l.admit(who, 'edit')).toEqual({ ok: false, reason: 'sign_in' });
    for (let i = 0; i < 10; i++) expect(await l.admit(who, 'handoff')).toEqual({ ok: true });
    expect(await l.admit(who, 'handoff')).toEqual({ ok: false, reason: 'sign_in' });
  });

  it('the global anonymous cap refuses a new IP once reached, and signed-in users are unaffected', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const day = new Date().toISOString().slice(0, 10);
    await sql`insert into app.builder_usage (scope, day, kind, n) values ('global', ${day}::date, 'draft', ${ANON_DRAFTS_GLOBAL})`;
    const fresh = { ip: ip() };
    expect(await l.admit(fresh, 'draft')).toEqual({ ok: false, reason: 'sign_in' });
    // The refused visitor was not charged on their own bucket (the check is one transaction).
    const rows = (await sql`select n from app.builder_usage where scope = ${'ip:' + fresh.ip} and kind = 'draft'`) as { n: number }[];
    expect(rows.length === 0 || rows[0]!.n === 0).toBe(true);
    expect(await l.admit({ ip: ip(), userId: 'u-1' }, 'draft')).toEqual({ ok: true });
  });

  it('the global trial cap works the same way', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const day = new Date().toISOString().slice(0, 10);
    await sql`insert into app.builder_usage (scope, day, kind, n) values ('global', ${day}::date, 'trial', ${ANON_TRIALS_GLOBAL})`;
    expect(await l.admit({ ip: ip() }, 'trial')).toEqual({ ok: false, reason: 'sign_in' });
  });

  it('20 concurrent admits at limit 3 admit exactly 3', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const who = { ip: ip() };
    const rs = await Promise.all(Array.from({ length: 20 }, () => l.admit(who, 'draft')));
    expect(rs.filter((r) => r.ok).length).toBe(3);
    const g = (await sql`select n from app.builder_usage where scope = 'global' and kind = 'draft'`) as { n: number }[];
    expect(g[0]!.n).toBe(3); // refused admits are not counted globally
  });

  it('a new UTC day resets', async () => {
    await reset();
    let day = '2026-10-12';
    const l = createBuilderLimits(sql, { day: () => day });
    const who = { ip: ip() };
    for (let i = 0; i < 3; i++) await l.admit(who, 'draft');
    expect(await l.admit(who, 'draft')).toEqual({ ok: false, reason: 'sign_in' });
    day = '2026-10-13';
    expect(await l.admit(who, 'draft')).toEqual({ ok: true });
  });

  it("a user's 11th draft is daily, and the 11th trial too; the IP does not matter", async () => {
    await reset();
    const l = createBuilderLimits(sql);
    for (let i = 0; i < 10; i++) expect(await l.admit({ ip: ip(), userId: 'u-2' }, 'draft')).toEqual({ ok: true });
    expect(await l.admit({ ip: ip(), userId: 'u-2' }, 'draft')).toEqual({ ok: false, reason: 'daily' });
    for (let i = 0; i < 10; i++) expect(await l.admit({ ip: ip(), userId: 'u-2' }, 'trial')).toEqual({ ok: true });
    expect(await l.admit({ ip: ip(), userId: 'u-2' }, 'trial')).toEqual({ ok: false, reason: 'daily' });
    expect(await l.admit({ ip: ip(), userId: 'u-3' }, 'draft')).toEqual({ ok: true });
  });

  it('signed-in drafts do not use up the anonymous global cap', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    await l.admit({ ip: ip(), userId: 'u-4' }, 'draft');
    expect((await sql`select 1 from app.builder_usage where scope = 'global'`).length).toBe(0);
  });

  it('IPv6 addresses of one /64 share a bucket', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    expect(await l.admit({ ip: '2001:db8:1:2::1' }, 'draft')).toEqual({ ok: true });
    expect(await l.admit({ ip: '2001:db8:1:2:aaaa::2' }, 'draft')).toEqual({ ok: true });
    expect(await l.admit({ ip: '2001:db8:1:2:bbbb::3' }, 'draft')).toEqual({ ok: true });
    expect(await l.admit({ ip: '2001:db8:1:2:cccc::4' }, 'draft')).toEqual({ ok: false, reason: 'sign_in' });
    expect(await l.admit({ ip: '2001:db8:1:3::1' }, 'draft')).toEqual({ ok: true });
  });

  it('addTokens adds to the visitor bucket and, for anonymous drafts, the global one', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const who = { ip: ip() };
    await l.admit(who, 'draft');
    await l.addTokens(who, 'draft', 1200);
    await l.addTokens(who, 'draft', 300);
    const rows = (await sql`select scope, tokens::int as tokens from app.builder_usage where kind = 'draft' order by scope`) as { scope: string; tokens: number }[];
    expect(rows.map((r) => [r.scope.startsWith('ip:') ? 'ip' : r.scope, r.tokens])).toEqual([['global', 1500], ['ip', 1500]]);
    await l.addTokens({ ip: ip(), userId: 'u-5' }, 'draft', 40);
    const u = (await sql`select tokens::int as tokens from app.builder_usage where scope = 'user:u-5'`) as { tokens: number }[];
    expect(u[0]!.tokens).toBe(40);
  });

  it('a global daily ceiling of 500 on signed-in drafts refuses with capacity, charges nobody, and leaves trials alone', async () => {
    await reset();
    expect(USER_DRAFTS_GLOBAL).toBe(500);
    const l = createBuilderLimits(sql);
    const day = new Date().toISOString().slice(0, 10);
    await sql`insert into app.builder_usage (scope, day, kind, n) values ('global:user', ${day}::date, 'draft', ${USER_DRAFTS_GLOBAL})`;
    expect(await l.admit({ ip: ip(), userId: 'u-g1' }, 'draft')).toEqual({ ok: false, reason: 'capacity' });
    const own = (await sql`select n from app.builder_usage where scope = 'user:u-g1' and kind = 'draft'`) as { n: number }[];
    expect(own.length === 0 || own[0]!.n === 0).toBe(true); // one transaction: the refused user was not charged
    expect(await l.admit({ ip: ip(), userId: 'u-g1' }, 'trial')).toEqual({ ok: true });
    expect(await l.admit({ ip: ip() }, 'draft')).toEqual({ ok: true }); // anonymous has its own ceiling
  });

  it('the per-user limit still answers daily, and a refusal there does not count against the global ceiling', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    for (let i = 0; i < USER_DRAFTS; i++) expect(await l.admit({ ip: ip(), userId: 'u-g2' }, 'draft')).toEqual({ ok: true });
    expect(await l.admit({ ip: ip(), userId: 'u-g2' }, 'draft')).toEqual({ ok: false, reason: 'daily' });
    const g = (await sql`select n from app.builder_usage where scope = 'global:user' and kind = 'draft'`) as { n: number }[];
    expect(g[0]!.n).toBe(USER_DRAFTS);
  });

  it('concurrent signed-in admits cannot overshoot the global ceiling', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    const day = new Date().toISOString().slice(0, 10);
    await sql`insert into app.builder_usage (scope, day, kind, n) values ('global:user', ${day}::date, 'draft', ${USER_DRAFTS_GLOBAL - 3})`;
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => l.admit({ ip: ip(), userId: `u-c${i}` }, 'draft')));
    expect(rs.filter((r) => r.ok).length).toBe(3);
    expect(rs.filter((r) => !r.ok && r.reason === 'capacity').length).toBe(9);
  });

  it('signed-in draft tokens are added to the global ceiling bucket too', async () => {
    await reset();
    const l = createBuilderLimits(sql);
    await l.admit({ ip: ip(), userId: 'u-g3' }, 'draft');
    await l.addTokens({ ip: ip(), userId: 'u-g3' }, 'draft', 700);
    const g = (await sql`select tokens::int as tokens from app.builder_usage where scope = 'global:user' and kind = 'draft'`) as { tokens: number }[];
    expect(g[0]!.tokens).toBe(700);
  });
});
