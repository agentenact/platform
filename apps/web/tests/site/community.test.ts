import { describe, expect, test } from 'bun:test';
import { API_BASE } from '../../src/lib/explore';
import { byline, communityHref, loadCommunity, parseCommunity } from '../../src/lib/community';

const SHA = 'a'.repeat(64);
const G = 'GDO73LCGEXAMPLEADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXAWECM';
const item = (o: Record<string, unknown> = {}) => ({ sha256: SHA, title: 'XLM dip alert', summary: 'Emails you when XLM falls.', author: { network: 'stellar:testnet', address: G, name: 'knrs' }, ...o });

describe('parseCommunity', () => {
  test('keeps well-formed items with their handle', () => {
    expect(parseCommunity({ templates: [item()] })).toEqual([{ sha256: SHA, title: 'XLM dip alert', summary: 'Emails you when XLM falls.', author: G, name: 'knrs' }]);
  });
  test('an odd handle is dropped, never the template', () => {
    expect(parseCommunity({ templates: [item({ author: { address: G, name: 'Kerem <b>' } })] })[0]?.name).toBeNull();
  });
  test('drops items without a hash, title, summary or address, and odd shapes', () => {
    expect(parseCommunity({ templates: [item({ sha256: 'nope' }), item({ title: ' ' }), item({ summary: 1 }), item({ author: {} }), null] })).toEqual([]);
    expect(parseCommunity(null)).toEqual([]);
    expect(parseCommunity({ templates: 'x' })).toEqual([]);
  });
});

describe('loadCommunity', () => {
  test('reads the public index', async () => {
    let url = '';
    const f = (async (u: string) => ((url = u), new Response(JSON.stringify({ templates: [item()] })))) as unknown as typeof fetch;
    expect(await loadCommunity(undefined, 10, f)).toHaveLength(1);
    expect(url).toBe(`${API_BASE}/public/templates?limit=10`);
  });
  test('any failure is an empty list', async () => {
    expect(await loadCommunity(undefined, 10, (async () => new Response('x', { status: 503 })) as unknown as typeof fetch)).toEqual([]);
    expect(await loadCommunity(undefined, 10, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toEqual([]);
  });
});

test('href and byline: the handle always beside the short address', () => {
  expect(communityHref(SHA)).toBe(`/draft?template=c-${SHA}`);
  expect(byline({ author: G, name: 'knrs' })).toBe('knrs · GDO7…WECM');
  expect(byline({ author: G, name: null })).toBe('GDO7…WECM');
});
