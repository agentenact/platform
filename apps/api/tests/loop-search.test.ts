import { describe, expect, it } from 'bun:test';
import { createOpenRouterSearch, OPENROUTER_CHAT_URL } from '../src/loop/search.js';
import { MODEL_IDS } from '../src/loop/models.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

// Shape from OpenRouter's web-search docs (2026-10-07): choices[0].message.annotations[].url_citation.
const answer = (annotations: unknown[]) => ({ id: 'gen-1', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'Stellar is', annotations } }], usage: { prompt_tokens: 900, completion_tokens: 64 } });
const cite = (url: string, title?: string, content?: string) => ({ type: 'url_citation', url_citation: { url, title, content, start_index: 0, end_index: 5 } });

describe('openRouterSearch', () => {
  it('refuses to be built without the key', () => {
    expect(() => createOpenRouterSearch({ safeFetch: fakeSafeFetch(() => undefined), env: {} })).toThrow('loop: OPENROUTER_API_KEY is not set');
  });

  it('asks the cheap model for the web plugin with a tiny budget and maps citations', async () => {
    const sf = fakeSafeFetch((url) =>
      url === OPENROUTER_CHAT_URL
        ? { body: answer([cite('https://stellar.org/', 'Stellar', `${'x '.repeat(2000)}`), cite('https://stellar.org/', 'dup'), { type: 'other' }, cite('https://b.example/')]) }
        : undefined,
    );
    const search = createOpenRouterSearch({ safeFetch: sf, env: { OPENROUTER_API_KEY: 'or-key' } });
    const r = await search('stellar xlm', 5);
    expect(r.map((x) => [x.title, x.url])).toEqual([['Stellar', 'https://stellar.org/'], ['', 'https://b.example/']]);
    expect(r[0]!.description.length).toBeLessThanOrEqual(500);
    const c = sf.calls[0]!;
    expect(c.o.method).toBe('POST');
    expect(c.o.headers).toMatchObject({ authorization: 'Bearer or-key', 'content-type': 'application/json', 'x-title': 'AgentEnact', 'http-referer': 'https://agentenact.io' });
    const body = JSON.parse(c.o.body as string);
    expect(body.model).toBe(MODEL_IDS.cheap);
    expect(body.plugins).toEqual([{ id: 'web', engine: 'exa', max_results: 5 }]);
    expect(body.max_tokens).toBeLessThanOrEqual(100);
    expect(body.messages).toEqual([{ role: 'user', content: 'stellar xlm' }]);
  });

  it('caps the results at count', async () => {
    const sf = fakeSafeFetch(() => ({ body: answer([cite('https://a.example/'), cite('https://b.example/'), cite('https://c.example/')]) }));
    expect(await createOpenRouterSearch({ safeFetch: sf, env: { OPENROUTER_API_KEY: 'k' } })('q', 2)).toHaveLength(2);
  });

  it('fails with a fixed code on a non-200 or junk answer', async () => {
    const env = { OPENROUTER_API_KEY: 'k' };
    await expect(createOpenRouterSearch({ safeFetch: fakeSafeFetch(() => ({ status: 402, body: { error: { message: 'secret-ish', code: 402 } } })), env })('q', 5)).rejects.toMatchObject({ code: 'search_failed' });
    await expect(createOpenRouterSearch({ safeFetch: fakeSafeFetch(() => ({ body: '<html>', contentType: 'text/html' })), env })('q', 5)).rejects.toMatchObject({ code: 'search_failed' });
    expect(await createOpenRouterSearch({ safeFetch: fakeSafeFetch(() => ({ body: { choices: [{ message: { content: 'hi' } }] } })), env })('q', 5)).toEqual([]);
  });
});
