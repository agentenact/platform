import { describe, expect, it } from 'bun:test';
import { callDetail, joinDetails, splitDetails } from '../src/loop/call-detail.js';

describe('callDetail', () => {
  it('keeps the search and its hits, the page read (never its text), the email, the note', () => {
    expect(callDetail('web_search', { query: 'Stellar DeFi news' }, { results: [{ title: 'A', url: 'https://a.com/x', snippet: 's' }, { title: 'B', url: 'javascript:alert(1)' }] }))
      .toEqual({ query: 'Stellar DeFi news', results: [{ title: 'A', url: 'https://a.com/x' }] });
    expect(callDetail('web_read', { url: 'https://user:pw@a.com/p' }, { url: 'https://a.com/p', title: 'Page', text: 'secret page text' })).toEqual({ url: 'https://a.com/p', title: 'Page' });
    expect(callDetail('send_email', { subject: 'Digest', text: '**Hi**' }, { sent: true })).toEqual({ subject: 'Digest', body: '**Hi**' });
    expect(callDetail('remember', { key: 'k', value: 'XLM at 0.16' }, { ok: true })).toEqual({ note: 'XLM at 0.16' });
  });

  it('clips long text, never shows a webhook address or arguments that look secret, and never throws', () => {
    expect(Array.from(callDetail('send_email', { subject: 's', text: 'x'.repeat(5000) }, {})!.body!).length).toBe(4000);
    expect(callDetail('send_webhook', { text: 'hello' }, { sent: true })).toEqual({ body: 'hello' });
    expect(callDetail('stellar_read', { account: 'G', private_key: 'S' }, {})).toBeNull();
    expect(callDetail('stellar_price', { symbol: 'XLM' }, {})).toEqual({ input: '{"symbol":"XLM"}' });
    expect(callDetail('web_search', null, null)).toBeNull();
  });

  it('splits details off the steps and puts them back in place', () => {
    const steps: { n: number; calls?: { tool: string; line: string | null; detail?: { note: string } }[] }[] = [{ n: 1, calls: [{ tool: 'a', line: null }, { tool: 'b', line: 'x', detail: { note: 'n' } }] }, { n: 2 }];
    const { steps: bare, details } = splitDetails(steps);
    expect(details).toEqual([{ n: 1, i: 1, d: { note: 'n' } }]);
    expect(bare[0]!.calls![1]).toEqual({ tool: 'b', line: 'x' });
    expect(joinDetails(bare, details)).toEqual(steps);
    expect(joinDetails(bare, 'odd')).toEqual(bare);
  });
});
