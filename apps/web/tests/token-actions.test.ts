import { describe, expect, test } from 'bun:test';
import { createTokenActions } from '../src/server/token-actions';
import type { ApiCall } from '../src/server/api';

const view = { id: '00000000-0000-4000-8000-000000000001', name: 'laptop', hint: 'ae_pat_abcd', createdAt: '2026-10-28T10:00:00Z', expiresAt: '2027-01-26T10:00:00Z', lastUsedAt: null };

function fake(answer: { status: number; json?: unknown }) {
  const calls: { path: string; init: unknown }[] = [];
  const api = (async (path: string, init: unknown) => {
    calls.push({ path, init });
    return { status: answer.status, json: answer.json ?? null };
  }) as unknown as ApiCall;
  return { api, calls };
}

describe('token actions', () => {
  test('signed out: 401 without calling the api', async () => {
    const f = fake({ status: 200 });
    const t = createTokenActions({ api: f.api, token: async () => undefined });
    expect(await t.list()).toEqual({ ok: false, status: 401 });
    expect(f.calls).toHaveLength(0);
  });

  test('issue returns the key once and a view without it', async () => {
    const f = fake({ status: 201, json: { ...view, token: `ae_pat_${'A'.repeat(43)}`, extra: 'x' } });
    const out = await createTokenActions({ api: f.api, token: async () => 'jwt' }).issue('  laptop ');
    expect(out).toEqual({ ok: true, token: `ae_pat_${'A'.repeat(43)}`, view });
    expect(f.calls[0]).toMatchObject({ path: '/api/tokens', init: { token: 'jwt', method: 'POST', body: { name: 'laptop' } } });
  });

  test('issue maps the cap to its status and refuses a blank name locally', async () => {
    const t = createTokenActions({ api: fake({ status: 409, json: { error: 'too_many_tokens' } }).api, token: async () => 'jwt' });
    expect(await t.issue('a')).toEqual({ ok: false, status: 409 });
    expect(await t.issue('   ')).toEqual({ ok: false, status: 400 });
  });

  test('revoke checks the id shape, then posts', async () => {
    const f = fake({ status: 204 });
    const t = createTokenActions({ api: f.api, token: async () => 'jwt' });
    expect(await t.revoke('../x')).toEqual({ ok: false, status: 400 });
    expect(await t.revoke(view.id)).toEqual({ ok: true });
    expect(f.calls.map((c) => c.path)).toEqual([`/api/tokens/${view.id}/revoke`]);
  });

  test('an api that throws reads as 503', async () => {
    const api = (async () => {
      throw new Error('down');
    }) as unknown as ApiCall;
    expect(await createTokenActions({ api, token: async () => 'jwt' }).list()).toEqual({ ok: false, status: 503 });
  });
});
