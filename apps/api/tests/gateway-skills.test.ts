import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import type { Db } from '../src/db/index.js';
import { createApp, type AppDeps } from '../src/gateway/app.js';
import { SKILL_READS_PER_HOUR } from '../src/gateway/skills-routes.js';
import type { SkillCatalog } from '../src/skills/index.js';
import type { SkillSets } from '../src/skills/sets.js';
import { freshDb } from './support/db.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';
const AGENT = '11111111-2222-4333-8444-555555555555';
const HASH = 'c'.repeat(64);
const COMMIT = 'a'.repeat(40);

describe('gateway skills routes', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let base: Omit<AppDeps, 'skills'>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const verify: AuthVerifier = async (t) => (t.startsWith('tok:') ? { id: t.slice(4), email: `${t.slice(4)}@example.com` } : null);
    base = { sql, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN };
  });
  afterAll(() => drop());

  /**
   * A catalog that records what reached it; the routes are tested for auth, validation and limits, not the catalog. Every
   * read misses the cache unless `cached` says so; a miss runs the route's limit as the real catalog does.
   */
  function fake(cached = false) {
    const calls: unknown[][] = [];
    const cat: SkillCatalog = {
      async suggestions(u, agent, q, onMiss) { if (!cached) await onMiss?.(); calls.push(['suggestions', u, agent, q]); return { version: 3, queries: ['q'], suggestions: [] }; },
      async review(id, onMiss) { if (!cached) await onMiss?.(); calls.push(['review', id]); return { id } as never; },
      async list(...a) { calls.push(['list', ...a]); return { version: 3, skills: [], services: [] }; },
      async approve(...a) { calls.push(['approve', ...a]); return { version: 4 }; },
      async remove(...a) { calls.push(['remove', ...a]); return { version: 5 }; },
      async setServiceSkills(...a) { calls.push(['setServiceSkills', ...a]); return { version: 6 }; },
      async pinned(...a) { calls.push(['pinned', ...a]); return {} as never; },
      async search(q) { calls.push(['search', q]); return { suggestions: [] }; },
    };
    return { cat, calls };
  }
  const user = '9d2f4a1e-0000-4000-8000-000000000001';
  const req = (path: string, o: { method?: string; body?: unknown; who?: string | null } = {}) =>
    new Request(`${API}${path}`, {
      method: o.method ?? 'GET',
      // The panel's own origin: app CORS reflects only a listed Origin header.
      headers: { origin: ORIGIN, ...(o.who === null ? {} : { authorization: `Bearer tok:${o.who ?? user}` }), ...(o.body ? { 'content-type': 'application/json' } : {}) },
      ...(o.body ? { body: JSON.stringify(o.body) } : {}),
    });

  it('every route needs a signed-in user', async () => {
    const { cat, calls } = fake();
    const h = createApp({ ...base, skills: { catalog: cat } });
    for (const [p, m] of [[`/api/agents/${AGENT}/skills`, 'GET'], [`/api/agents/${AGENT}/skills/suggestions`, 'GET'], ['/api/skills/search', 'GET'], ['/api/skills/review?id=a/b/c', 'GET'], [`/api/agents/${AGENT}/skills`, 'POST'], [`/api/agents/${AGENT}/skills/x?version=1`, 'DELETE'], [`/api/agents/${AGENT}/services/digest/skills`, 'PUT']] as const) {
      expect((await h(req(p, { method: m, who: null }))).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('passes the caller, the agent and validated input to the catalog, with the app CORS', async () => {
    const { cat, calls } = fake();
    const h = createApp({ ...base, skills: { catalog: cat } });
    const s = await h(req(`/api/agents/${AGENT}/skills/suggestions?q=defi%20news`));
    expect([s.status, s.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    expect((await h(req('/api/skills/review?id=acme/skills/defi-digest'))).status).toBe(200);
    const ok = await h(req(`/api/agents/${AGENT}/skills`, { method: 'POST', body: { id: 'acme/skills/defi-digest', commit: COMMIT, contentHash: HASH, version: 3, acceptRisk: true } }));
    expect([ok.status, await ok.json()]).toEqual([200, { version: 4 }]);
    expect((await h(req(`/api/agents/${AGENT}/skills/defi-digest?version=4`, { method: 'DELETE' }))).status).toBe(200);
    expect((await h(req(`/api/agents/${AGENT}/services/digest/skills`, { method: 'PUT', body: { skills: ['defi-digest'], version: 5 } }))).status).toBe(200);
    expect(calls).toEqual([
      ['suggestions', user, AGENT, 'defi news'],
      ['review', 'acme/skills/defi-digest'],
      ['approve', user, AGENT, { id: 'acme/skills/defi-digest', commit: COMMIT, contentHash: HASH, version: 3, acceptRisk: true }],
      ['remove', user, AGENT, 'defi-digest', 4],
      ['setServiceSkills', user, AGENT, 'digest', ['defi-digest'], 5],
    ]);
  });

  it('refuses malformed input before the catalog sees it', async () => {
    const { cat, calls } = fake();
    const h = createApp({ ...base, skills: { catalog: cat } });
    const bad = [
      req('/api/skills/review?id=../etc/passwd'),
      req('/api/skills/review'),
      req(`/api/agents/${AGENT}/skills/suggestions?q=${'x'.repeat(61)}`),
      req(`/api/agents/${AGENT}/skills`, { method: 'POST', body: { id: 'a/b/c', commit: COMMIT, contentHash: HASH } }),
      req(`/api/agents/${AGENT}/skills`, { method: 'POST', body: { id: 'a/b/c', commit: COMMIT, contentHash: HASH, version: 1, acceptRisk: 'yes' } }),
      req(`/api/agents/${AGENT}/skills/defi-digest`, { method: 'DELETE' }),
      req(`/api/agents/${AGENT}/skills/defi-digest?version=0`, { method: 'DELETE' }),
      req(`/api/agents/${AGENT}/services/digest/skills`, { method: 'PUT', body: { skills: ['a', 'b', 'c'], version: 1 } }),
      req(`/api/agents/${AGENT}/services/digest/skills`, { method: 'PUT', body: { skills: ['Bad Name'], version: 1 } }),
      req(`/api/agents/${AGENT}/services/digest/skills`, { method: 'PUT', body: { skills: [] } }),
    ];
    for (const r of bad) expect((await h(r)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('caps suggestion and review reads per user per hour, with retry-after', async () => {
    const { cat } = fake();
    let t = 0;
    const h = createApp({ ...base, skills: { catalog: cat, now: () => t } });
    for (let i = 0; i < SKILL_READS_PER_HOUR; i++) await h(req(i % 2 ? '/api/skills/review?id=a/b/c' : `/api/agents/${AGENT}/skills/suggestions`));
    const r = await h(req('/api/skills/review?id=a/b/c'));
    expect([r.status, r.headers.get('retry-after')]).toEqual([429, '3600']);
    expect((await h(req(`/api/agents/${AGENT}/skills`))).status).toBe(200); // the list is a plain read of our own data
    t = 3_600_000;
    expect((await h(req('/api/skills/review?id=a/b/c'))).status).toBe(200);
  });

  it('a cached answer costs nothing against the cap', async () => {
    const { cat } = fake(true);
    const h = createApp({ ...base, skills: { catalog: cat } });
    for (let i = 0; i < SKILL_READS_PER_HOUR + 5; i++) expect((await h(req(`/api/agents/${AGENT}/skills/suggestions`))).status).toBe(200);
  });

  const SET = '22222222-3333-4444-8555-666666666666';
  function fakeSets() {
    const calls: unknown[][] = [];
    const sets: SkillSets = {
      async list(...a) { calls.push(['list', ...a]); return []; },
      async approved(...a) { calls.push(['approved', ...a]); return []; },
      async create(...a) { calls.push(['create', ...a]); return { id: SET, revision: 1 }; },
      async createWith(...a) { calls.push(['createWith', ...a]); return { id: SET, revision: 1 }; },
      async rename(...a) { calls.push(['rename', ...a]); },
      async remove(...a) { calls.push(['remove', ...a]); },
      async addSkill(...a) { calls.push(['addSkill', ...a]); return { revision: 2 }; },
      async removeSkill(...a) { calls.push(['removeSkill', ...a]); return { revision: 3 }; },
      async forAgent(...a) { calls.push(['forAgent', ...a]); return { version: 3, sets: [] }; },
      async apply(...a) { calls.push(['apply', ...a]); return { version: 4, added: [], updated: [] }; },
    };
    return { sets, calls };
  }

  it('skill set routes: signed-in only, validated, owner and ids passed through', async () => {
    const { cat } = fake();
    const { sets, calls } = fakeSets();
    const h = createApp({ ...base, skills: { catalog: cat, sets } });
    const routes = [
      ['/api/skill-sets', 'GET'], ['/api/skill-sets/approved', 'GET'], ['/api/skill-sets', 'POST'], [`/api/skill-sets/${SET}`, 'PUT'], [`/api/skill-sets/${SET}`, 'DELETE'],
      [`/api/skill-sets/${SET}/skills`, 'POST'], [`/api/skill-sets/${SET}/skills/x?revision=1`, 'DELETE'], [`/api/agents/${AGENT}/skill-sets`, 'GET'], [`/api/agents/${AGENT}/skill-sets/${SET}/apply`, 'POST'],
    ] as const;
    for (const [p, m] of routes) expect((await h(req(p, { method: m, who: null }))).status).toBe(401);
    const bad = [
      req('/api/skill-sets', { method: 'POST', body: { name: '' } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', fromAgent: 'nope' } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', skills: 'a/b/c' } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', skills: [{ id: 'nope', contentHash: HASH }] } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', skills: [{ id: 'a/b/c', contentHash: 'short' }] } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', fromAgent: AGENT, skills: [] } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', skills: [{ id: 'a/b/c', contentHash: HASH, commit: 1 }] } }),
      req('/api/skill-sets', { method: 'POST', body: { name: 'x', skills: [{ id: 'a/b/c', contentHash: HASH, commit: COMMIT, acceptRisk: 'yes' }] } }),
      req(`/api/skills/search?q=${'x'.repeat(61)}`),
      req(`/api/skill-sets/${SET}`, { method: 'PUT', body: { name: 3 } }),
      req(`/api/skill-sets/${SET}/skills`, { method: 'POST', body: { id: 'a/b/c', commit: COMMIT, contentHash: HASH } }),
      req(`/api/skill-sets/${SET}/skills/x`, { method: 'DELETE' }),
      req(`/api/agents/${AGENT}/skill-sets/${SET}/apply`, { method: 'POST', body: { version: 1 } }),
    ];
    for (const r of bad) expect((await h(r)).status).toBe(400);
    expect(calls).toEqual([]);

    expect((await h(req('/api/skill-sets'))).status).toBe(200);
    expect((await h(req('/api/skill-sets/approved'))).status).toBe(200);
    expect((await h(req('/api/skill-sets', { method: 'POST', body: { name: 'Research', fromAgent: AGENT } }))).status).toBe(200);
    expect((await h(req('/api/skill-sets', { method: 'POST', body: { name: 'Picked', skills: [{ id: 'a/b/c', contentHash: HASH, junk: 1 }, { id: 'a/b/d', contentHash: HASH, commit: COMMIT }] } }))).status).toBe(200);
    expect((await h(req(`/api/skill-sets/${SET}`, { method: 'PUT', body: { name: 'Notes' } }))).status).toBe(204);
    expect((await h(req(`/api/skill-sets/${SET}/skills`, { method: 'POST', body: { id: 'a/b/c', commit: COMMIT, contentHash: HASH, revision: 1, acceptRisk: true } }))).status).toBe(200);
    expect((await h(req(`/api/skill-sets/${SET}/skills/c?revision=2`, { method: 'DELETE' }))).status).toBe(200);
    expect((await h(req(`/api/agents/${AGENT}/skill-sets`))).status).toBe(200);
    const ap = await h(req(`/api/agents/${AGENT}/skill-sets/${SET}/apply`, { method: 'POST', body: { version: 3, revision: 3 } }));
    expect([ap.status, await ap.json()]).toEqual([200, { version: 4, added: [], updated: [] }]);
    expect((await h(req(`/api/skill-sets/${SET}`, { method: 'DELETE' }))).status).toBe(204);
    expect(calls).toEqual([
      ['list', user],
      ['approved', user],
      ['create', user, 'Research', AGENT],
      ['createWith', user, 'Picked', [{ id: 'a/b/c', contentHash: HASH }, { id: 'a/b/d', contentHash: HASH, commit: COMMIT, acceptRisk: false }]],
      ['rename', user, SET, 'Notes'],
      ['addSkill', user, SET, { id: 'a/b/c', commit: COMMIT, contentHash: HASH, revision: 1, acceptRisk: true }],
      ['removeSkill', user, SET, 'c', 2],
      ['forAgent', user, AGENT],
      ['apply', user, AGENT, SET, { version: 3, revision: 3 }],
      ['remove', user, SET],
    ]);
  });

  it('without the catalog the routes are 404', async () => {
    expect((await createApp(base)(req(`/api/agents/${AGENT}/skills`))).status).toBe(404);
  });
});
