import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FEATURED, ReadyAgents } from '../src/components/ready-agents';
import { copy } from '../src/copy';
import { TEMPLATES } from '../src/lib/templates';
import { createDraftController, type DraftActions } from '../src/lib/draft-controller';
import { draftReducer, initialState, planBoot, readDraftParams, type DraftAction, type DraftState } from '../src/lib/draft-state';
import type { ActionResult } from '../src/lib/draft-types';
import { createApiCall } from '../src/server/api';
import { createBuilderActions } from '../src/server/builder-actions';
import { sampleDraft } from './support/draft';

const ok = <T extends object>(v: T): ActionResult<T> => ({ ok: true, ...v });
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('homepage: ready agents', () => {
  test('each template is a plain link to it in the /create builder, so it works without scripts', () => {
    const html = renderToStaticMarkup(createElement(ReadyAgents));
    for (const id of FEATURED) expect(html).toContain(`href="/create?template=${id}"`);
    expect(html.match(/href="\/create\?template=/g)).toHaveLength(FEATURED.length);
    expect(html).toContain(`All ${TEMPLATES.length} ready agents`);
  });
  test("ids, titles and summaries match the api's templates", async () => {
    const { agentTemplates } = await import('../../api/src/builder/templates');
    expect<{ id: string; title: string; summary: string }[]>(TEMPLATES.map(({ id, title, summary }) => ({ id, title, summary }))).toEqual(agentTemplates().map(({ id, title, summary }) => ({ id, title, summary })));
  });
});

describe('?template=', () => {
  test('is read only when it is a kebab-case id', () => {
    expect(readDraftParams({ template: 'xlm-drop' })).toEqual({ template: 'xlm-drop' });
    for (const bad of ['XLM', '../x', 'a b', '-x', 'x'.repeat(41), ''])
      expect(readDraftParams({ template: bad })).toEqual({});
  });
  test('a handoff wins; a template wins over a prompt and over this tab’s saved draft', () => {
    expect(planBoot({ handoff: 'AbCdEfGhIjKlMnOpQrStUv', template: 'xlm-drop', stored: null })).toEqual({ kind: 'handoff', id: 'AbCdEfGhIjKlMnOpQrStUv' });
    expect(planBoot({ prompt: 'watch xlm', template: 'xlm-drop', stored: { prompt: 'p', draft: sampleDraft() } })).toEqual({ kind: 'template', id: 'xlm-drop' });
  });
});

function rig(template: DraftActions['template']) {
  const calls: string[] = [];
  const writes: string[] = [];
  const log: DraftAction[] = [];
  let state: DraftState = initialState;
  const no = (fn: string) => async () => (calls.push(fn), ok({ draft: sampleDraft() as unknown }));
  const actions: DraftActions = { draft: no('draft'), edit: no('edit'), claim: no('claim'), trial: async () => (calls.push('trial'), ok({ trial: {} })), template: (id) => (calls.push(`template:${id}`), template(id)) };
  const m = new Map<string, string>();
  const ctl = createDraftController(actions, {
    getState: () => state,
    dispatch: (a) => (log.push(a), (state = draftReducer(state, a))),
    getWindow: () => ({ location: { href: 'https://app.test/draft?template=xlm-drop' }, history: { state: null, replaceState: (_s: unknown, _u: string, url: string) => void writes.push(url) } }),
    replace: () => {},
    store: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) },
  });
  return { ctl, calls, writes, log, get state() { return state; } };
}

describe('opening a template', () => {
  test('lands the ready draft with no model call, after the id left the address bar', async () => {
    const r = rig(async () => ok({ draft: sampleDraft({ name: 'From template' }) as unknown }));
    r.ctl.boot({ template: 'xlm-drop' });
    expect(r.writes).toEqual(['/draft']);
    await flush();
    expect(r.calls).toEqual(['template:xlm-drop']);
    expect(r.state.phase).toBe('ready');
    expect(r.state.draft?.name).toBe('From template');
  });
  test('an unknown template fails plainly, and Retry opens the template again (never an empty draft)', async () => {
    let n = 0;
    const r = rig(async () => (++n === 1 ? { ok: false, kind: 'failed', message: copy.errors.notFound } : ok({ draft: sampleDraft() as unknown })));
    r.ctl.boot({ template: 'nope' });
    await flush();
    expect([r.state.phase, r.state.message]).toEqual(['failed', copy.errors.notFound]);
    await r.ctl.onRetry();
    expect(r.calls).toEqual(['template:nope', 'template:nope']);
    expect(r.state.phase).toBe('ready');
  });
  test('a thrown action ends on the generic line', async () => {
    const r = rig(async () => {
      throw new Error('boom');
    });
    r.ctl.boot({ template: 'xlm-drop' });
    await flush();
    expect([r.state.phase, r.state.message]).toEqual(['failed', copy.errors.generic]);
  });
});

describe('the template action', () => {
  const setup = (body: unknown, status = 200) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = createApiCall({
      fetch: (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch,
      baseUrl: 'https://api.test',
      panelSecret: () => 'panel-secret-value',
      requestHeaders: async () => new Headers(),
    });
    return { seen, actions: createBuilderActions({ api, token: async () => 'tok' }) };
  };
  const list = { templates: [{ id: 'xlm-drop', title: 'XLM drop alert', summary: 's', draft: { name: 'XLM drop alert' } }] };

  test('GETs the list with no bearer and no panel secret, and picks the id', async () => {
    const { seen, actions } = setup(list);
    expect(await actions.template('xlm-drop')).toEqual({ ok: true, draft: { name: 'XLM drop alert' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.test/api/builder/templates');
    expect(seen[0]!.init.method).toBe('GET');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-panel-secret']).toBeUndefined();
  });
  test('an id the api does not list is a failure', async () => {
    expect((await setup(list).actions.template('other')).ok).toBe(false);
  });
  test('a malformed id never calls the api', async () => {
    const { seen, actions } = setup(list);
    expect((await actions.template('../admin')).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
  test('a 503 maps to failed', async () => {
    expect((await setup({}, 503).actions.template('xlm-drop')).ok).toBe(false);
  });
});
