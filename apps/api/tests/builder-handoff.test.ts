import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { xlmDrop } from '../src/builder/examples.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHandoffs, emailSha256, HANDOFF_SWEEP } from '../src/builder/handoff.js';
import type { Db } from '../src/db/index.js';
import { freshDb } from './support/db.js';

describe('draft handoffs (store)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  const count = async () => Number(((await sql`select count(*)::int as n from app.draft_handoffs`) as { n: number }[])[0]!.n);

  it('put then claim returns the draft once; the second claim is null', async () => {
    const h = createHandoffs(sql);
    const id = await h.put(xlmDrop());
    expect(await h.claim(id)).toEqual(xlmDrop());
    expect(await h.claim(id)).toBeNull();
  });

  it('an expired handoff is null', async () => {
    const h = createHandoffs(sql, { ttlMs: -1000 });
    const id = await h.put(xlmDrop());
    expect(await h.claim(id)).toBeNull();
  });

  it('ids are unguessable: 22 base64url characters, no sequence', async () => {
    const h = createHandoffs(sql);
    const ids = await Promise.all([h.put(xlmDrop()), h.put(xlmDrop()), h.put(xlmDrop())]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(ids).size).toBe(3);
  });

  it('a malformed id is null without touching the database', async () => {
    let queries = 0;
    const spy = new Proxy(sql, { apply: (t, th, a) => (queries++, Reflect.apply(t as never, th, a)) }) as unknown as Db;
    const h = createHandoffs(spy);
    for (const bad of ['', 'short', 'a'.repeat(21), 'a'.repeat(23), `${'a'.repeat(21)}!`, `${'a'.repeat(21)}%`, "' or 1=1 --"]) expect(await h.claim(bad)).toBeNull();
    expect(queries).toBe(0);
  });

  it('two concurrent claims of one id give exactly one success', async () => {
    const h = createHandoffs(sql);
    for (let round = 0; round < 5; round++) {
      const id = await h.put(xlmDrop());
      const got = await Promise.all(Array.from({ length: 8 }, () => h.claim(id)));
      expect(got.filter((d) => d !== null)).toHaveLength(1);
    }
  });

  it('put refuses a draft that carries a service, a hire target or a webhook, and stores nothing', async () => {
    const h = createHandoffs(sql);
    const before = await count();
    const withWebhook = xlmDrop();
    withWebhook.spec.delivery.webhook_url = 'https://example.com/hook';
    const withHire = xlmDrop();
    withHire.spec.hire_targets = [{ url: 'https://agent.example/a', max_usdc: '0.05' }];
    const withService = xlmDrop();
    withService.spec.services = [{ slug: 'x', name: 'X', description: 'x', price_usdc: '0.01', prompt: 'x' } as never];
    for (const d of [withWebhook, withHire, withService]) await expect(h.put(d)).rejects.toThrow('handoff: draft refused');
    await expect(h.put({ nope: 1 } as never)).rejects.toThrow();
    expect(await count()).toBe(before);
  });

  describe('email-bound', () => {
    const hex = (e: string) => createHash('sha256').update(e).digest('hex');

    it('emailSha256 trims and lower-cases, nothing else; empty or missing gives undefined', () => {
      expect(emailSha256('  Ada@Example.COM ')).toBe(hex('ada@example.com'));
      expect(emailSha256('ada+x@example.com')).not.toBe(emailSha256('ada@example.com'));
      expect(emailSha256('   ')).toBeUndefined();
      expect(emailSha256(undefined)).toBeUndefined();
      expect(emailSha256(42 as never)).toBeUndefined();
    });

    it('claims with the same email in another case and with spaces; another email gets null and the row stays', async () => {
      const h = createHandoffs(sql);
      const id = await h.put(xlmDrop(), emailSha256('ada@example.com'));
      expect(await h.claim(id, 'eve@example.com')).toBeNull();
      expect(await h.claim(id, null)).toBeNull();
      expect(await h.claim(id, undefined)).toBeNull();
      expect(await h.claim(id, '')).toBeNull();
      expect(await h.claim(id, ' ADA@Example.com ')).toEqual(xlmDrop());
      expect(await h.claim(id, 'ada@example.com')).toBeNull();
    });

    it('a handoff without a hash claims for anyone, with or without an email', async () => {
      const h = createHandoffs(sql);
      expect(await h.claim(await h.put(xlmDrop()), 'eve@example.com')).toEqual(xlmDrop());
      expect(await h.claim(await h.put(xlmDrop()), null)).toEqual(xlmDrop());
      expect(await h.claim(await h.put(xlmDrop()))).toEqual(xlmDrop());
    });

    it('the table holds only 64 hex characters, never the email', async () => {
      const h = createHandoffs(sql);
      const id = await h.put(xlmDrop(), emailSha256('Ada@Example.com'));
      const rows = (await sql`select * from app.draft_handoffs where id = ${id}`) as Record<string, unknown>[];
      expect(JSON.stringify(rows[0])).not.toContain('ada@example');
      expect(rows[0]!.email_sha256).toBe(hex('ada@example.com'));
    });

    it('the email is never logged or stored by the handoff code', () => {
      for (const f of ['../src/builder/handoff.ts', '../src/gateway/builder.ts']) {
        const src = readFileSync(join(import.meta.dir, f), 'utf8');
        expect(src).not.toMatch(/console\.|\blog\(/);
        expect(src).not.toMatch(/insert into app\.draft_handoffs[^`]*\bemail\b[^_]/);
      }
    });

    it('a wrong-email claim does not shorten or delete the row (still there for the right account)', async () => {
      const h = createHandoffs(sql);
      const id = await h.put(xlmDrop(), emailSha256('ada@example.com'));
      await Promise.all(Array.from({ length: 5 }, () => h.claim(id, 'eve@example.com')));
      expect(await count()).toBeGreaterThan(0);
      expect(await h.claim(id, 'ada@example.com')).toEqual(xlmDrop());
    });
  });

  it('put deletes expired rows, at most HANDOFF_SWEEP per call', async () => {
    await sql`delete from app.draft_handoffs`;
    const n = HANDOFF_SWEEP + 5;
    await sql`insert into app.draft_handoffs (id, draft, expires_at)
              select substr(md5(g::text) || md5(g::text || 'x'), 1, 22), ${xlmDrop()}, now() - interval '1 hour' from generate_series(1, ${n}) g`;
    await sql`insert into app.draft_handoffs (id, draft, expires_at) values (${'L'.repeat(22)}, ${xlmDrop()}, now() + interval '1 hour')`;
    expect(await count()).toBe(n + 1);
    const h = createHandoffs(sql);
    await h.put(xlmDrop());
    expect(await count()).toBe(n + 1 - HANDOFF_SWEEP + 1);
    await h.put(xlmDrop());
    expect(await count()).toBe(1 + 1 + 1); // the sweep finished the backlog; the live one and two new rows remain
    expect(await h.claim('L'.repeat(22))).toEqual(xlmDrop());
  });
});
