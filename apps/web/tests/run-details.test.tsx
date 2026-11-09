import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { RunDetails, RunPanel } from '../src/components/run-details';
import { copy } from '../src/copy';
import { asRunDetail, type RunDetail } from '../src/lib/agent-types';
import { durationWords, fetchOnce, shortId, txUrl, type RunOut } from '../src/lib/run-details';
import { createLoadRun } from '../src/server/run-data';
import type { ApiCall } from '../src/server/api';
import { bannedWord } from '../src/lib/words';
import { AGENT_ID, NOW } from './support/agent';
import { stripAdvanced, textOf } from './support/screens';

const RUN_ID = '0b9a7c2e-1d4f-4a6b-8c3d-5e6f7a8b9c0d';
const TX = 'a'.repeat(64);
const run = (o: Partial<RunDetail> = {}): RunDetail => ({
  id: RUN_ID,
  mode: 'mission',
  status: 'done',
  stopReason: 'done',
  steps: [
    { n: 1, tools: ['stellar_price'], inputTokens: 120, outputTokens: 30, finishReason: 'tool-calls' },
    { n: 2, tools: ['send_email'], inputTokens: 200, outputTokens: 40, finishReason: 'stop' },
  ],
  inputTokens: 320,
  outputTokens: 70,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  toolCalls: 2,
  usdcSpent: '0.0030000',
  usdcEarned: '0.0000000',
  settlementTx: null,
  summary: 'XLM fell 5.8% in an hour.',
  model: null,
  triggerId: '11112222-3333-4444-5555-666677778888',
  serviceId: null,
  startedAt: '2026-10-13T12:00:00.000Z',
  endedAt: '2026-10-13T12:00:07.400Z',
  ...o,
});
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const render = (r: RunDetail, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RunDetails, { run: r, ...extra }));

describe('the plain part', () => {
  test('one line per step, the summary, how long it took and what it cost; no banned word outside the technical region', () => {
    const plain = text(stripAdvanced(render(run())));
    expect(plain).toContain('Read the price');
    expect(plain).toContain('Emailed you');
    expect(plain).toContain('XLM fell 5.8% in an hour.');
    expect(plain).toContain('Took 7 s');
    expect(plain).toContain('Spent $0.003 on testnet');
    expect(bannedWord(plain)).toBeNull();
    expect(plain).not.toMatch(/earned/i);
  });
  test('calls[].line are the plain steps; a null line uses that call\'s tool words; "more" is "…and more"', () => {
    const r = run({
      steps: [
        { n: 1, tools: ['stellar_price_change'], inputTokens: 1, outputTokens: 1, finishReason: 'tool-calls', calls: [{ tool: 'stellar_price_change', line: 'XLM moved −5.30% in the last hour' }] },
        { n: 2, tools: ['web_search', 'send_email'], inputTokens: 1, outputTokens: 1, finishReason: 'stop', calls: [
          { tool: 'web_search', line: null },
          { tool: 'send_email', line: 'Emailed you: "XLM is down"' },
          { tool: 'more', line: null },
        ] },
      ],
    });
    const plain = text(stripAdvanced(render(r)));
    expect(plain).toContain('XLM moved −5.30% in the last hour');
    expect(plain).toContain('Searched the web');
    expect(plain).toContain('Emailed you: "XLM is down"');
    expect(plain).toContain('…and more');
    expect(plain).not.toContain('more_');
    expect(plain).not.toContain('Read the price');
    expect(bannedWord(plain)).toBeNull();
  });
  test('an api line with a technical word is never shown outside the technical region', () => {
    const r = run({ steps: [{ n: 1, tools: ['compute'], inputTokens: 1, outputTokens: 1, finishReason: 'stop', calls: [{ tool: 'compute', line: 'Checked the settlement hash' }] }] });
    const plain = text(stripAdvanced(render(r)));
    expect(plain).not.toContain('settlement');
    expect(plain).toContain('Worked something out');
  });
  test('the model shows only inside the technical details, and not at all when unknown', () => {
    const r = run({ model: 'anthropic/claude-test-1' });
    expect(text(stripAdvanced(render(r)))).not.toContain('claude-test-1');
    const tech = text(render(r).slice(render(r).indexOf('data-advanced')));
    expect(tech).toContain('Model');
    expect(tech).toContain('anthropic/claude-test-1');
    expect(text(render(run()))).not.toContain('Model');
  });
  test('asRunDetail keeps calls and model, and drops a call it cannot read', () => {
    const calls = [{ tool: 'stellar_price', line: 'XLM is at $0.1913' }, { tool: 'compute', line: null }];
    const raw = { run: { ...run({ model: 'm/x' }), steps: [{ n: 1, tools: ['stellar_price'], inputTokens: 1, outputTokens: 1, finishReason: 'stop', calls: [...calls, { tool: 7 }, 'x'] }] } };
    const got = asRunDetail(raw)!;
    expect(got.model).toBe('m/x');
    expect(got.steps[0]!.calls).toEqual(calls);
    expect(asRunDetail({ run: { ...run(), model: 5 } })!.model).toBeNull();
  });
  test('a run that costs nothing and is still running says so', () => {
    const plain = text(stripAdvanced(render(run({ usdcSpent: '0.0000000', endedAt: null, status: 'running' }))));
    expect(plain).toContain('Spent nothing');
    expect(plain).toContain('Still running');
    expect(plain).not.toContain('Took');
  });
  test('a sale says what it earned and links the proof, https only', () => {
    const sale = run({ mode: 'service', usdcEarned: '0.0010000', settlementTx: TX, triggerId: null, serviceId: 'xlm-check' });
    const plain = text(stripAdvanced(render(sale, { proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' })));
    expect(plain).toContain('Earned $0.001 on testnet');
    expect(stripAdvanced(render(sale, { proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' }))).toContain('href="https://agentenact.io/verify?agent=a&amp;tx=b"');
    expect(stripAdvanced(render(sale, { proofUrl: 'http://agentenact.io/x' }))).not.toContain('<a ');
    expect(stripAdvanced(render(sale))).not.toContain('<a ');
    expect(bannedWord(plain)).toBeNull();
  });
  test('a problem is plain and does not claim a result', () => {
    const plain = text(stripAdvanced(render(run({ status: 'error', stopReason: 'error', summary: null, steps: [] }), { problem: true })));
    expect(plain).toContain('Something went wrong');
    expect(bannedWord(plain)).toBeNull();
  });
  test('the summary is escaped', () => {
    expect(render(run({ summary: '<img src=x onerror=1>' }))).not.toContain('<img');
  });
});

describe('the technical region', () => {
  test('is one collapsed data-advanced details element with the table', () => {
    const html = render(run());
    expect(html.match(/data-advanced=""/g)).toHaveLength(1);
    expect(html).toMatch(/<details[^>]*data-advanced=""/);
    expect(html).not.toMatch(/<details[^>]* open/);
    const t = text(html.slice(html.indexOf('data-advanced')));
    for (const s of ['Technical details', 'Started by', 'Schedule 11112222', '1. Read the price'.replace('Read the price', 'stellar_price'), '(120 in, 30 out)', '2 steps, 2 tool calls, 320 tokens in, 70 out, 15 cached', '0.003', 'done', '2026-10-13 12:00:00 UTC', '2026-10-13 12:00:07 UTC']) expect(t).toContain(s);
    expect(t).not.toMatch(/model/i);
  });
  test('the settlement link only appears for a real 64-character hash', () => {
    const link = (tx: string | null) => render(run({ mode: 'service', usdcEarned: '0.001', settlementTx: tx }));
    expect(link(TX)).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX}"`);
    for (const bad of ['abc', 'A'.repeat(64), `${TX}x`, 'javascript:alert(1)', `${TX}/../x`]) expect(link(bad)).not.toContain('stellar.expert');
    expect(link(null)).not.toContain('stellar.expert');
    expect(txUrl(TX)).toBe(`https://stellar.expert/explorer/testnet/tx/${TX}`);
    expect(txUrl('nope')).toBeNull();
  });
  test('a service id and a chat run are shown by who started them', () => {
    expect(text(render(run({ mode: 'service', triggerId: null, serviceId: 'xlm-check-service-long' })))).toContain('Service xlm-chec');
    expect(text(render(run({ mode: 'chat', triggerId: null })))).toContain('You, in chat');
  });
});

describe('helpers', () => {
  test('durations and short ids', () => {
    expect(durationWords('2026-10-13T12:00:00Z', '2026-10-13T12:00:07.400Z')).toBe('Took 7 s');
    expect(durationWords('2026-10-13T12:00:00Z', null)).toBe('Still running');
    expect(durationWords('2026-10-13T12:00:00Z', 'garbage')).toBe('Still running');
    expect(shortId('11112222-3333')).toBe('11112222');
    expect(shortId(TX, 8)).toBe('aaaaaaaa…aaaaaaaa');
  });
  test('asRunDetail keeps a good answer and drops an odd one', () => {
    expect(asRunDetail(JSON.parse(JSON.stringify({ run: run() })))).toEqual(run());
    expect(asRunDetail({ run: { ...run(), steps: 'x' } })).toBeNull();
    expect(asRunDetail({ run: { ...run(), usdcSpent: 'free' } })).toBeNull();
    expect(asRunDetail({})).toBeNull();
    expect(asRunDetail(null)).toBeNull();
  });
  test('fetchOnce asks once per run, shares an in-flight ask, and does not remember a failure', async () => {
    const cache = new Map<string, Promise<RunOut>>();
    let calls = 0;
    const ok = async () => (calls++, { ok: true as const, run: run() });
    const [a, b] = await Promise.all([fetchOnce(cache, RUN_ID, ok), fetchOnce(cache, RUN_ID, ok)]);
    await fetchOnce(cache, RUN_ID, ok);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    let n = 0;
    const flaky = async () => (n++ === 0 ? { ok: false as const } : { ok: true as const, run: run() });
    expect((await fetchOnce(cache, 'other', flaky)).ok).toBe(false);
    expect((await fetchOnce(cache, 'other', flaky)).ok).toBe(true);
    expect(n).toBe(2);
    expect((await fetchOnce(cache, 'thrower', async () => { throw new Error('boom'); })).ok).toBe(false);
  });
});

describe('the panel states', () => {
  test('loading and failed are plain words; ready shows the details', () => {
    expect(text(renderToStaticMarkup(createElement(RunPanel, { state: { kind: 'loading' } })))).toContain(copy.runDetails.loading);
    const failed = renderToStaticMarkup(createElement(RunPanel, { state: { kind: 'error' }, onRetry: () => undefined }));
    expect(text(failed)).toContain(copy.runDetails.failed);
    expect(bannedWord(text(failed))).toBeNull();
    expect(text(renderToStaticMarkup(createElement(RunPanel, { state: { kind: 'ready', run: run() } })))).toContain('Emailed you');
  });
});

describe('the feed rows', () => {
  const items = [
    { type: 'alert' as const, at: '2026-10-13T08:00:00Z', runId: 'run-a', text: 'XLM fell.' },
    { type: 'sale' as const, at: '2026-10-13T08:05:00Z', runId: 'run-b', usdc: '0.001', proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' },
    { type: 'problem' as const, at: '2026-10-12T07:00:00Z', runId: 'run-c' },
    { type: 'quiet' as const, at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 2 },
    { type: 'alert' as const, at: '2026-10-13T07:00:00Z', text: 'no run id' },
  ];
  const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, items, now: NOW }));
  const li = (type: string, nth = 0) => html.split('<li ').filter((s) => s.includes(`data-item="${type}"`))[nth]!;

  test('alert, sale and problem rows with a run are buttons, closed at first', () => {
    for (const t of ['alert', 'sale', 'problem']) {
      expect(li(t)).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
      expect(li(t)).toMatch(/<div id="[^"]+" hidden=""/);
    }
  });
  test('a row with no transaction shows no transaction column at all (no "not on chain" label)', () => {
    expect(li('quiet')).not.toContain('data-tx');
    expect(li('quiet')).not.toContain('on chain');
  });
  test('quiet rows and rows without a run are not expandable', () => {
    expect(li('quiet')).not.toContain('<button');
    expect(li('alert', 1)).not.toContain('<button');
    expect(html.match(/<button/g)).toHaveLength(3);
  });
  test('the proof link stays in the sale row and is not inside the button', () => {
    const sale = li('sale');
    expect(sale).toContain('proof ↗');
    expect(sale.slice(sale.indexOf('<button'), sale.indexOf('</button>'))).not.toContain('<a ');
  });
  test('nothing is fetched while rendering', () => {
    let called = 0;
    renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, items, now: NOW, fetchRun: async (): Promise<RunOut> => (called++, { ok: false }) }));
    expect(called).toBe(0);
  });
});

describe('the server read', () => {
  const ok = (json: unknown): ApiCall => async () => ({ status: 200, json });
  const load = (api: ApiCall, token: string | null = 't') => createLoadRun({ api, token: async () => token ?? undefined });
  test('calls the owner route with the token and returns the run', async () => {
    const seen: string[] = [];
    const out = await load(async (path, o) => (seen.push(`${path}|${o?.token}`), { status: 200, json: { run: run() } }))(AGENT_ID, RUN_ID);
    expect(seen).toEqual([`/api/agents/${AGENT_ID}/runs/${RUN_ID}|t`]);
    expect(out).toEqual({ ok: true, run: run() });
  });
  test('bad ids never reach the api; signed out, 404, 5xx, odd bodies and throws are plain failures', async () => {
    let calls = 0;
    const spy: ApiCall = async () => (calls++, { status: 200, json: { run: run() } });
    expect((await load(spy)('x', RUN_ID)).ok).toBe(false);
    expect((await load(spy)(AGENT_ID, '../x')).ok).toBe(false);
    expect((await load(spy, null)(AGENT_ID, RUN_ID)).ok).toBe(false);
    expect(calls).toBe(0);
    for (const status of [401, 404, 500]) expect((await load(async () => ({ status, json: null }))(AGENT_ID, RUN_ID)).ok).toBe(false);
    expect((await load(ok({ run: { nope: 1 } }))(AGENT_ID, RUN_ID)).ok).toBe(false);
    expect((await load(async () => { throw new Error('x'); })(AGENT_ID, RUN_ID)).ok).toBe(false);
  });
});

describe('a run that is still running is asked for again', () => {
  test('fetchOnce does not keep an answer for a run with no end, so the next open sees the finished run', async () => {
    const cache = new Map<string, Promise<RunOut>>();
    let calls = 0;
    const ask = async (): Promise<RunOut> => (calls++, { ok: true, run: run({ endedAt: calls === 1 ? null : '2026-10-13T12:00:07.400Z' }) });
    const first = await fetchOnce(cache, RUN_ID, ask);
    expect(first.ok && first.run.endedAt).toBeNull();
    const second = await fetchOnce(cache, RUN_ID, ask);
    expect(calls).toBe(2);
    expect(second.ok && second.run.endedAt).not.toBeNull();
    await fetchOnce(cache, RUN_ID, ask); // a finished run is kept
    expect(calls).toBe(2);
  });

  test('while the ask is in flight a second open still shares it', async () => {
    const cache = new Map<string, Promise<RunOut>>();
    let calls = 0;
    const ask = async (): Promise<RunOut> => (calls++, { ok: true, run: run({ endedAt: null }) });
    await Promise.all([fetchOnce(cache, RUN_ID, ask), fetchOnce(cache, RUN_ID, ask)]);
    expect(calls).toBe(1);
  });
});

describe('agent-written text goes through the plain-words rule', () => {
  const LONG = `G${'A'.repeat(51)}WXYZ`;

  test('an alert with a technical word shows a plain line; the words never reach the page outside Technical details', () => {
    const items = [{ type: 'alert' as const, at: '2026-10-13T11:50:00Z', text: 'tx 3fa9 settled, token balance low', runId: RUN_ID }];
    const html = renderToStaticMarkup(createElement(ActivityFeed, { items, now: NOW, agentId: AGENT_ID }));
    const shown = text(stripAdvanced(html));
    expect(shown).toContain(copy.activity.alertPlain);
    expect(shown).not.toMatch(/token|settled/i);
    expect(bannedWord(shown)).toBeNull();
  });

  test('a plain alert is shown as written, with a long address shortened', () => {
    const items = [{ type: 'alert' as const, at: '2026-10-13T11:50:00Z', text: `${LONG} sent you 5 XLM`, runId: RUN_ID }];
    const shown = text(renderToStaticMarkup(createElement(ActivityFeed, { items, now: NOW, agentId: AGENT_ID })));
    expect(shown).toContain('GAAA\u2026WXYZ sent you 5 XLM');
    expect(shown).not.toContain(LONG);
  });

  test('a run summary with a technical word is hidden from the plain part and kept in Technical details', () => {
    const html = render(run({ summary: 'Paid the service, tx hash 3fa9' }));
    const plain = text(stripAdvanced(html));
    expect(plain).not.toMatch(/service|hash|tx/i);
    expect(bannedWord(plain)).toBeNull();
    expect(text(html.match(/<details[\s\S]*<\/details>/)![0])).toContain('Paid the service, tx hash 3fa9');
  });

  test('a plain run summary is still shown, and addresses are shortened', () => {
    const plain = text(stripAdvanced(render(run({ summary: `Sent 2 XLM to ${LONG}.` }))));
    expect(plain).toContain('Sent 2 XLM to GAAA\u2026WXYZ.');
  });
});
