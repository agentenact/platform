import { describe, expect, it } from 'bun:test';
import type { ToolSet } from 'ai';
import { renderAlertEmail } from '../src/tools/alert-email.js';
import { bannedWord } from '../src/builder/words.js';
import { RESEND_URL } from '../src/tools/deliver.js';
import { createToolbox } from '../src/tools/index.js';
import { fakeSafeFetch } from './support/safe-fetch.js';
import { minimalSpec } from './support/specs.js';

const APP = 'https://app.agentenact.io';
const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const base = { agentName: 'XLM watcher', agentId: AGENT, runId: RUN, appOrigin: APP, subject: 'XLM fell 5.4% in the last hour', body: 'XLM went from 0.1042 to 0.0986.\n\nThat is past your 5% limit.', cap: 20 };
const visible = (html: string) => html.replace(/<title>.*?<\/title>/s, '').replace(/<[^>]+>/g, ' ');

describe('renderAlertEmail', () => {
  it('starts the subject with the agent name, once', () => {
    expect(renderAlertEmail(base).subject).toBe('XLM watcher: XLM fell 5.4% in the last hour');
    expect(renderAlertEmail({ ...base, subject: 'XLM watcher says hello' }).subject).toBe('XLM watcher says hello');
  });

  it('escapes model text everywhere: markup, script and attribute breakouts stay inert', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> "quoted" & \'single\' <a href="javascript:x">go</a>';
    const m = renderAlertEmail({ ...base, subject: evil, body: evil, facts: { reading: evil } });
    for (const html of [m.html]) {
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<a href="javascript');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&quot;quoted&quot; &amp; &#39;single&#39;');
    }
    expect(m.text).toContain(evil); // plain text part is text, shown as written
  });

  it('escapes a hostile agent name', () => {
    const m = renderAlertEmail({ ...base, agentName: '<b>x</b>"' });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keeps paragraphs and does not turn model text into links', () => {
    const m = renderAlertEmail({ ...base, body: 'one\n\ntwo https://evil.example/x' });
    expect(m.html.match(/<p /g)!.length).toBe(2);
    expect(m.html).not.toContain('href="https://evil.example');
  });

  it('has exactly two app links: the run and the pause page, neither carrying anything secret', () => {
    const m = renderAlertEmail(base);
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs).toEqual([`${APP}/dashboard/${AGENT}?run=${RUN}`, `${APP}/dashboard/pause?agent=${AGENT}`]);
    expect(m.html).toContain('>See what I saw</a>');
    expect(m.html).toContain('>Pause my agent</a>');
    expect(m.text).toContain(`See what I saw: ${APP}/dashboard/${AGENT}?run=${RUN}`);
    expect(m.text).toContain(`Pause my agent: ${APP}/dashboard/pause?agent=${AGENT}`);
  });

  it('without a run, See what I saw opens the agent page', () => {
    const { runId: _r, ...noRun } = base;
    expect(renderAlertEmail(noRun).html).toContain(`href="${APP}/dashboard/${AGENT}"`);
  });

  it('shows the real facts it was given and nothing it was not', () => {
    const m = renderAlertEmail({ ...base, facts: { reading: 'XLM moved −5.40% in the last hour', at: new Date('2026-10-16T14:05:00Z'), checksToday: 64 } });
    expect(m.html).toContain('What I checked');
    expect(m.html).toContain('XLM moved −5.40% in the last hour');
    expect(m.html).toContain('14:05 UTC');
    expect(m.html).toContain('64 checks today');
    expect(m.text).toContain('What I checked');
    const bare = renderAlertEmail(base);
    expect(bare.html).not.toContain('checks today');
    expect(bare.html).not.toContain('UTC');
  });

  it('is honest about the reading and states the real daily cap', () => {
    const m = renderAlertEmail(base);
    expect(visible(m.html)).toContain('I send at most 20 emails a day');
    expect(visible(m.html)).toContain('I cannot promise a reading is right');
    expect(visible(m.html)).toContain('Testnet, free');
  });

  it('has a plain-text part with the headline, the words and the fine print', () => {
    const m = renderAlertEmail(base);
    expect(m.text.startsWith('XLM fell 5.4% in the last hour')).toBe(true);
    expect(m.text).toContain('That is past your 5% limit.');
    expect(m.text).toContain('I send at most 20 emails a day');
  });

  it('is inline-styled, light, with the seal, and without script, stylesheet or event handlers', () => {
    const html = renderAlertEmail(base).html;
    expect(html).toContain(`src="${APP}/brand/seal-ink-96.png"`);
    expect(html).toContain('background:#f7f2ec');
    const low = html.toLowerCase();
    for (const bad of ['<script', '<link', '<style', '@import']) expect(low).not.toContain(bad);
    expect(low).not.toMatch(/\son[a-z]+=/);
    expect(html).toContain('width=device-width');
  });

  it('our own words pass the plain-words scan', () => {
    const m = renderAlertEmail({ ...base, subject: 'Price alert', body: 'Moved.', facts: { reading: 'XLM is at $0.10', at: new Date(0), checksToday: 3 } });
    expect(bannedWord(visible(m.html).replace(/XLM watcher/g, ''))).toBeNull();
    expect(bannedWord(m.text)).toBeNull();
  });
});

describe('send_email tool', () => {
  const run = (t: ToolSet[string] | undefined, input: unknown) => t!.execute!(input as never, { toolCallId: 't1', messages: [] } as never);
  function toolbox() {
    const sf = fakeSafeFetch((url) => (url === RESEND_URL ? { body: { id: 'e1' } } : undefined));
    const tb = createToolbox({
      safeFetch: sf,
      memory: { remember: async () => 'saved' },
      specs: { skillBody: async () => null },
      policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true },
      webhookSecret: () => 'ab'.repeat(32),
      mailFrom: 'AgentEnact <agents@agentenact.io>',
      appOrigin: APP,
      env: { RESEND_API_KEY: 'k' },
    });
    return { tb, sf };
  }

  it('sends the branded html and the plain text together, to the owner only', async () => {
    const { tb, sf } = toolbox();
    const tools = tb.ownerTools({ agentId: AGENT, agentName: 'XLM watcher', ownerEmail: 'o@example.com', mode: 'mission', spec: minimalSpec({ tools: ['send_email'] }), runId: RUN });
    expect(await run(tools.send_email, { subject: 'XLM alert', text: '<b>XLM</b> crossed 0.30' })).toEqual({ sent: true, id: 'e1' });
    const body = JSON.parse(String(sf.calls.find((c) => c.url === RESEND_URL)!.o.body));
    expect(body.to).toEqual(['o@example.com']);
    expect(body.subject).toBe('XLM watcher: XLM alert');
    expect(body.html).toContain('&lt;b&gt;XLM&lt;/b&gt; crossed 0.30');
    expect(body.html).toContain(`${APP}/dashboard/pause?agent=${AGENT}`);
    expect(body.text).toContain('<b>XLM</b> crossed 0.30');
  });

  it('with an outbox (a mission) it counts the mail against the cap and hands it over instead of sending', async () => {
    const { tb, sf } = toolbox();
    const box: { subject: string; text: string }[] = [];
    const tools = tb.ownerTools({ agentId: AGENT, agentName: 'n', ownerEmail: 'o@example.com', mode: 'mission', spec: minimalSpec({ tools: ['send_email'] }), runId: RUN, outbox: (m) => box.push(m) });
    expect(await run(tools.send_email, { subject: 's', text: 't' })).toEqual({ sent: true });
    expect(box).toEqual([{ subject: 's', text: 't' }]);
    expect(sf.calls.some((c) => c.url === RESEND_URL)).toBe(false);
  });

  it('the old plain message still goes when the context has no agent name', async () => {
    const { tb, sf } = toolbox();
    const tools = tb.ownerTools({ agentId: AGENT, ownerEmail: 'o@example.com', mode: 'chat', spec: minimalSpec({ tools: ['send_email'] }) });
    await run(tools.send_email, { subject: 's', text: 't' });
    expect(JSON.parse(String(sf.calls.find((c) => c.url === RESEND_URL)!.o.body))).toEqual({ from: 'AgentEnact <agents@agentenact.io>', to: ['o@example.com'], subject: 's', text: 't' });
  });
});

import { readingSentence } from '../src/checks/readings.js';
describe('readingSentence', () => {
  it('turns a stored reading into one plain sentence, or null', () => {
    expect(readingSentence({ symbol: 'XLM', changePct: -5.4, from: 0.1042, to: 0.0986 })).toBe('XLM moved −5.40%, from $0.1042 to $0.0986');
    expect(readingSentence({ symbol: 'XLM', price: 0.3 })).toBe('XLM was at $0.3000');
    expect(readingSentence({ count: 2, largest: '120 USDC' })).toBe('2 payments, the largest 120 USDC');
    expect(readingSentence({ account: 'GABC…WXYZ', XLM: 5 })).toBeNull();
    expect(readingSentence({ symbol: 'XLM', changePct: -1, from: 1, to: 1, stale: 1 })).toContain('out of date');
  });
});

describe('the alert email draws the markdown the model wrote', () => {
  it('lists, bold and headings become mail HTML; every character is escaped; links stay words; the text part has no markers', () => {
    const m = renderAlertEmail({ agentName: 'Digest', agentId: 'a', appOrigin: 'https://agentenact.io', subject: 'S', body: '## Today\n\n**XLM** down 2%\n\n- one <script>\n- [DefiLlama](https://defillama.com/chain/stellar)\n\n1. first' });
    expect(m.html).toContain('<strong>XLM</strong> down 2%');
    expect(m.html).toContain('<ul style="margin:0;padding-left:22px;"><li style="margin:0 0 6px;">one &lt;script&gt;</li><li style="margin:0 0 6px;">DefiLlama (defillama.com)</li></ul>');
    expect(m.html).toContain('<ol style="margin:0;padding-left:22px;">');
    expect(m.html).not.toContain('href="https://defillama.com');
    expect(m.text).toContain('Today\n\nXLM down 2%\n\n• one <script>\n• DefiLlama (defillama.com)\n\n1. first');
  });

  it('carries the seal: the transaction and its explorer link, or a pointer while it is on its way; nothing without one', () => {
    const base = { agentName: 'A', agentId: 'a1', runId: 'r1', appOrigin: 'https://agentenact.io', subject: 'S', body: 'B' };
    const tx = 'd'.repeat(64);
    const on = renderAlertEmail({ ...base, seal: { tx } });
    expect(on.html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${tx}"`);
    expect(on.text).toContain(`Transaction ${tx}`);
    const pending = renderAlertEmail({ ...base, seal: { tx: null } });
    expect(pending.html).toContain('Your agent is sealing this run on chain');
    expect(pending.html).toContain('https://agentenact.io/dashboard/a1?run=r1');
    expect(renderAlertEmail({ ...base, seal: { tx: '<script>' } }).html).not.toContain('<script>');
    expect(renderAlertEmail(base).html).not.toContain('Sealed on Stellar');
  });
});

