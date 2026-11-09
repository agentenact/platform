import { describe, expect, it } from 'bun:test';
import { createOpenRouterSearch, OPENROUTER_CHAT_URL } from '../src/loop/search.js';
import { createWeb, TAVILY_URL } from '../src/tools/web.js';
import { TITLE_MAX_CHARS } from '../src/tools/web-text.js';
import { egressError } from '../src/tools/safe-fetch.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

// Shape from docs.tavily.com (Search API, 2026-10-07): POST /search, Bearer auth, results[].{title,url,content,score}.
const tavily = { query: 'stellar xlm', results: [{ url: 'https://stellar.org/', title: 'Stellar', content: 'The <b>Stellar</b> network', score: 0.9, raw_content: null, favicon: null }], response_time: 0.4, usage: { credits: 1 }, request_id: 'r1' };
const orHit = { title: 'OR title', url: 'https://or.example/', description: 'snippet' };

function setup(o: { tavilyKey?: string; tavily?: { status?: number; body: unknown } | 'throw'; fallback?: 'ok' | 'fail'; admit?: boolean | 'agent' | 'global'; noFallback?: boolean } = {}) {
  const sf = fakeSafeFetch((url) => (url === TAVILY_URL && o.tavily !== 'throw' ? (o.tavily ?? { body: tavily }) : undefined));
  const real = sf as unknown as (u: string, x?: never) => Promise<unknown>;
  const safeFetch = Object.assign(async (u: string, x?: never) => {
    if (u === TAVILY_URL && o.tavily === 'throw') {
      sf.calls.push({ url: u, o: (x ?? {}) as never });
      throw egressError('timeout');
    }
    return real(u, x);
  }, { calls: sf.calls }) as unknown as typeof sf;
  const fb: { calls: [string, number][] } = { calls: [] };
  const events: Record<string, unknown>[] = [];
  const paid = { n: 0 };
  const web = createWeb({
    safeFetch,
    ...(o.tavilyKey !== undefined ? { tavilyKey: o.tavilyKey } : {}),
    ...(o.noFallback ? {} : { fallback: async (q: string, n: number) => {
      fb.calls.push([q, n]);
      if (o.fallback === 'fail') throw Object.assign(new Error('tool: search_failed'), { code: 'search_failed' });
      return [orHit];
    } }),
    log: (e) => events.push(e),
  });
  const search = (q = 'stellar xlm', n?: number) => web.search(q, n, undefined, () => (paid.n++, o.admit === undefined || o.admit === true ? (true as const) : o.admit === false ? ('agent' as const) : o.admit));
  return { search, sf: safeFetch, fb, events, paid };
}

describe('web_search', () => {
  it('Tavily success maps to results: one basic call, key on the first hop only, no fallback, no paid spend', async () => {
    const t = setup({ tavilyKey: 'tvly-secret' });
    expect(await t.search('stellar xlm', 3)).toEqual({ results: [{ title: 'Stellar', url: 'https://stellar.org/', description: 'The Stellar network' }] });
    expect(t.sf.calls).toHaveLength(1);
    const c = t.sf.calls[0]!;
    expect(c.url).toBe('https://api.tavily.com/search');
    expect(c.o.method).toBe('POST');
    expect(c.o.headers).toMatchObject({ authorization: 'Bearer tvly-secret', 'content-type': 'application/json' });
    expect(JSON.parse(c.o.body as string)).toEqual({ query: 'stellar xlm', max_results: 3, search_depth: 'basic', include_answer: false });
    expect([t.fb.calls.length, t.paid.n, t.events.length]).toEqual([0, 0, 0]);
  });

  it('caps Tavily results at count', async () => {
    const many = { results: Array.from({ length: 8 }, (_, i) => ({ url: `https://e${i}.example/`, title: 't', content: 'c' })) };
    expect((await setup({ tavilyKey: 'k', tavily: { body: many } }).search('q', 4)).results).toHaveLength(4);
  });

  for (const [name, status] of [['429', 429], ['432', 432], ['433', 433]] as const) {
    it(`Tavily quota (${name}) falls back to OpenRouter and logs a fixed event`, async () => {
      const t = setup({ tavilyKey: 'k', tavily: { status, body: { detail: { error: 'limit' } } } });
      expect(await t.search('secret query', 5)).toEqual({ results: [orHit] });
      expect(t.fb.calls).toEqual([['secret query', 5]]);
      expect(t.events).toEqual([{ event: 'search_fallback', reason: 'quota' }]);
      expect(t.paid.n).toBe(1);
    });
  }

  for (const [name, tavilyCase] of [['500', { status: 500, body: 'x' }], ['junk body', { body: '<html>', status: 200 }], ['network error', 'throw']] as const) {
    it(`Tavily failure (${name}) falls back with reason error`, async () => {
      const t = setup({ tavilyKey: 'k', tavily: tavilyCase as never });
      expect(await t.search()).toEqual({ results: [orHit] });
      expect(t.events).toEqual([{ event: 'search_fallback', reason: 'error' }]);
    });
  }

  for (const status of [401, 403]) {
    it(`Tavily auth failure (${status}) falls back with reason auth, apart from error`, async () => {
      const t = setup({ tavilyKey: 'k', tavily: { status, body: {} } });
      expect(await t.search()).toEqual({ results: [orHit] });
      expect(t.events).toEqual([{ event: 'search_fallback', reason: 'auth' }]);
    });
  }

  it('Tavily unconfigured goes straight to the fallback without calling Tavily', async () => {
    const t = setup({});
    expect(await t.search()).toEqual({ results: [orHit] });
    expect(t.sf.calls).toHaveLength(0);
    expect(t.events).toEqual([{ event: 'search_fallback', reason: 'unconfigured' }]);
  });

  it('bad arguments (400, 422) never fall back', async () => {
    for (const status of [400, 422]) {
      const t = setup({ tavilyKey: 'k', tavily: { status, body: { detail: 'bad' } } });
      await expect(t.search()).rejects.toMatchObject({ code: 'search_failed' });
      expect([t.fb.calls.length, t.paid.n, t.events.length]).toEqual([0, 0, 0]);
    }
  });

  it('both providers failing gives the fixed error', async () => {
    const t = setup({ tavilyKey: 'k', tavily: { status: 500, body: 'x' }, fallback: 'fail' });
    await expect(t.search()).rejects.toMatchObject({ code: 'search_failed', message: 'tool: search_failed' });
  });

  it('a refused paid slot is search_limit and never calls the fallback', async () => {
    const t = setup({ tavilyKey: 'k', tavily: { status: 429, body: {} }, admit: false });
    await expect(t.search()).rejects.toMatchObject({ code: 'search_limit' });
    expect(t.fb.calls).toHaveLength(0);
    expect(t.events).toEqual([{ event: 'search_limit', scope: 'agent' }]);
  });

  it('a global refusal logs scope global', async () => {
    const t = setup({ tavilyKey: 'k', tavily: { status: 429, body: {} }, admit: 'global' });
    await expect(t.search()).rejects.toMatchObject({ code: 'search_limit' });
    expect(t.events).toEqual([{ event: 'search_limit', scope: 'global' }]);
  });

  it('a missing admitPaid is a refusal, never uncapped', async () => {
    const calls: string[] = [];
    const web = createWeb({ safeFetch: fakeSafeFetch(() => undefined), fallback: async (q) => (calls.push(q), [orHit]) });
    await expect((web.search as unknown as (q: string) => Promise<unknown>)('q')).rejects.toMatchObject({ code: 'search_limit' });
    expect(calls).toEqual([]);
  });

  it('no fallback configured: fails before spending a paid slot', async () => {
    const t = setup({ tavilyKey: 'k', tavily: { status: 429, body: {} }, noFallback: true });
    await expect(t.search()).rejects.toMatchObject({ code: 'search_failed' });
    expect(t.paid.n).toBe(0);
  });

  it('the cap applies when Tavily is unconfigured too', async () => {
    await expect(setup({ admit: false }).search()).rejects.toMatchObject({ code: 'search_limit' });
  });

  it('never logs the key or the query', async () => {
    const t = setup({ tavilyKey: 'tvly-secret', tavily: { status: 500, body: 'x' } });
    await t.search('my private query');
    const text = JSON.stringify(t.events);
    expect(text).not.toContain('tvly-secret');
    expect(text).not.toContain('private');
  });

  it('the real OpenRouter hop carries the OpenRouter bearer and never the Tavily key', async () => {
    const sf = fakeSafeFetch((url) => (url === TAVILY_URL ? { status: 429, body: {} } : { body: { choices: [{ message: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://or.example/', title: 't', content: 'c' } }] } }] } }));
    const web = createWeb({ safeFetch: sf, tavilyKey: 'tvly-secret', fallback: createOpenRouterSearch({ safeFetch: sf, env: { OPENROUTER_API_KEY: 'or-key' } }) });
    expect((await web.search('q', 5, undefined, () => true)).results).toHaveLength(1);
    const or = sf.calls.filter((c) => c.url === OPENROUTER_CHAT_URL);
    expect(or).toHaveLength(1);
    expect(or[0]!.o.headers).toMatchObject({ authorization: 'Bearer or-key' });
    expect(JSON.stringify(or[0]!.o)).not.toContain('tvly-secret');
    expect(sf.calls.filter((c) => c.url === TAVILY_URL)[0]!.o.headers).toMatchObject({ authorization: 'Bearer tvly-secret' });
  });

  describe('web-sourced strings are cleaned and capped (both providers)', () => {
    const nasty = [
      { title: 'T'.repeat(200_000), url: 'https://ok.example/long', content: 'c' },
      { title: 'a\u0001b\u0007c', url: 'https://ok.example/ctl', content: 'x\u0001y' },
      { title: 'js', url: 'javascript:alert(1)', content: 'c' },
      { title: 'data', url: 'data:text/html,hi', content: 'c' },
      { title: 'far', url: `https://ok.example/${'u'.repeat(3000)}`, content: 'c' },
      { title: 'none', url: '', content: 'c' },
    ];
    const check = (r: { title: string; url: string; description: string }[]) => {
      expect(r.map((x) => x.url)).toEqual(['https://ok.example/long', 'https://ok.example/ctl']);
      expect(r[0]!.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(r[1]!.title).toBe('a b c');
      expect(r[1]!.description).toBe('x y');
    };
    it('tavily', async () => {
      const t = setup({ tavilyKey: 'k', tavily: { body: { results: nasty } } });
      check((await t.search('q', 10)).results);
    });
    it('openrouter', async () => {
      const sf = fakeSafeFetch(() => ({ body: { choices: [{ message: { annotations: nasty.map((x) => ({ type: 'url_citation', url_citation: { url: x.url, title: x.title, content: x.content } })) } }] } }));
      check(await createOpenRouterSearch({ safeFetch: sf, env: { OPENROUTER_API_KEY: 'k' } })('q', 10));
    });
  });
});
