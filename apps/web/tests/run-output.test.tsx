import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { Markdown } from '../src/components/markdown';
import { RunDetails } from '../src/components/run-details';
import { elapsedText, phaseText, RunProgress } from '../src/components/run-progress';
import { AgentHeader } from '../src/components/agent-header';
import { copy } from '../src/copy';
import { asCallDetail, asLiveRun, asRunDetail, type RunDetail } from '../src/lib/agent-types';
import { oneLineMarkdown, parseMarkdown, plainMarkdown } from '../src/lib/markdown';
import { createAgentActions } from '../src/server/agent-actions';
import { AGENT_ID, NOW, overview } from './support/agent';
import { stripAdvanced, textOf } from './support/screens';

const RUN_ID = '0b9a7c2e-1d4f-4a6b-8c3d-5e6f7a8b9c0d';
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const DIGEST = 'Digest sent.\n\n**Summary of what went out:**\n\n- **Market:** XLM ~$0.16\n- **Chain:** quiet\n\n1. one\n2. two\n\nSee [the post](https://example.com/p) and `code`.';

describe('the markdown parser', () => {
  test('is the same text in the web and the api', () => {
    const part = (f: string) => {
      const s = readFileSync(f, 'utf8');
      return s.slice(s.indexOf('// --- shared parser'), s.indexOf('// --- end shared parser ---'));
    };
    const web = part(join(import.meta.dir, '../src/lib/markdown.ts'));
    expect(web.length).toBeGreaterThan(500);
    expect(part(join(import.meta.dir, '../../api/src/tools/markdown.ts'))).toBe(web);
  });

  test('reads paragraphs, lists, bold and code; a link becomes its words and its host', () => {
    const b = parseMarkdown(DIGEST);
    expect(b.map((x) => x.t)).toEqual(['p', 'p', 'ul', 'ol', 'p']);
    expect(plainMarkdown(DIGEST)).not.toContain('**');
    expect(plainMarkdown(DIGEST)).toContain('the post (example.com)');
    expect(oneLineMarkdown(DIGEST)).not.toMatch(/\n|\*\*/);
  });

  test('draws it as plain elements, never as HTML or a link', () => {
    const h = renderToStaticMarkup(createElement(Markdown, { text: `${DIGEST}\n\n<script>alert(1)</script> <img src=x onerror=1>` }));
    expect(h).toContain('<ul');
    expect(h).toContain('<ol');
    expect(h).toContain('<strong');
    expect(h).toContain('<code');
    expect(h).not.toContain('<a ');
    expect(h).not.toContain('<script');
    expect(h).not.toContain('<img');
  });
});

const run = (o: Partial<RunDetail> = {}): RunDetail => ({
  id: RUN_ID, mode: 'mission', status: 'done', stopReason: 'done', steps: [], inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  toolCalls: 0, usdcSpent: '0', usdcEarned: '0', settlementTx: null, summary: 'Digest sent. **Summary**', model: null, triggerId: null, serviceId: null,
  startedAt: '2026-11-04T12:00:00.000Z', endedAt: '2026-11-04T12:01:00.000Z', ...o,
});

describe('a run, opened', () => {
  test('shows the whole answer formatted; the summary when there is no answer', () => {
    const h = renderToStaticMarkup(createElement(RunDetails, { run: run({ result: DIGEST }) }));
    expect(h).toContain('data-markdown');
    expect(h).toContain('<li');
    expect(text(h)).not.toContain('**Market');
    const s = renderToStaticMarkup(createElement(RunDetails, { run: run() }));
    expect(text(stripAdvanced(s))).toContain('Summary');
    expect(text(stripAdvanced(s))).not.toContain('**');
  });

  test('a step with details opens what the call was about', () => {
    const steps = [{ n: 1, tools: ['web_search', 'send_email'], inputTokens: 1, outputTokens: 1, finishReason: 'tool-calls', calls: [
      { tool: 'web_search', line: 'Searched the web', detail: { query: 'Stellar DeFi news', results: [{ title: 'DeFi weekly', url: 'https://a.com/x' }, { title: 'Bad', url: 'javascript:alert(1)' }] } },
      { tool: 'send_email', line: 'Emailed you', detail: { subject: 'Digest', body: '**Hi** there' } },
      { tool: 'remember', line: 'Made a note for next time' },
    ] }];
    const parsed = asRunDetail({ run: { ...run(), steps } })!;
    const h = renderToStaticMarkup(createElement(RunDetails, { run: parsed }));
    expect(h.match(/data-step-detail/g)?.length).toBe(2);
    expect(text(h)).toContain('Stellar DeFi news');
    expect(h).toContain('href="https://a.com/x"');
    expect(h).not.toContain('javascript:');
    expect(h).toContain('<strong');
  });

  test('details the api sends oddly are dropped', () => {
    expect(asCallDetail({ query: 5, results: [{ title: 1 }] })).toBeNull();
    expect(asCallDetail({ note: 'n', other: 'x' })).toEqual({ note: 'n' });
  });
});

describe('the feed row', () => {
  test('shows the answer on one line without markdown marks, under a top line with the time and the transaction', () => {
    const tx = { hash: 'a'.repeat(64), network: 'stellar:testnet' };
    const h = renderToStaticMarkup(
      createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, scheduled: true, items: [{ type: 'alert', at: new Date(NOW - 60_000).toISOString(), text: DIGEST, runId: RUN_ID, decision: { status: 'sent', tx } }] }),
    );
    expect(text(h)).not.toContain('**');
    expect(h).toContain('line-clamp-3');
    // the transaction sits in the top line, outside the button that opens the row
    const button = h.slice(h.indexOf('<button'), h.indexOf('</button>'));
    expect(button).not.toContain('data-tx');
    expect(h).toContain('data-tx');
  });
});

describe('the live panel', () => {
  test('reads the api answer and drops what it cannot draw', () => {
    expect(asLiveRun({ phase: 'working', since: '2026-11-04T12:00:00Z', lines: ['a', 5, ''], text: 'hi' })).toEqual({ phase: 'working', since: '2026-11-04T12:00:00Z', lines: ['a'], text: 'hi' });
    expect(asLiveRun({ phase: 'odd' })).toBeNull();
  });

  test('words per phase and the elapsed clock', () => {
    const l = { since: null, lines: [], text: '' };
    expect(phaseText({ ...l, phase: 'queued' })).toBe(copy.agent.progress.queued);
    expect(phaseText({ ...l, phase: 'working' })).toBe(copy.agent.progress.working);
    expect(phaseText({ ...l, phase: 'working', text: 'x' })).toBe(copy.agent.progress.writing);
    expect(phaseText({ ...l, phase: 'finishing' })).toBe(copy.agent.progress.finishing);
    expect(elapsedText(65_400)).toBe('1:05');
  });

  test('shows what it did and what it is writing, formatted', () => {
    const h = renderToStaticMarkup(createElement(RunProgress, { agentId: AGENT_ID, read: async () => null, initial: { phase: 'working', since: null, lines: ['Searched the web', 'Read a page on a.com'], text: '**Market:** up' } }));
    expect(h).toContain('data-run-progress="working"');
    expect(text(h)).toContain('Read a page on a.com');
    expect(h).toContain('<strong');
  });

  test('sits in the header only while a check is running', () => {
    const header = (running: boolean) => renderToStaticMarkup(createElement(AgentHeader, { agentId: AGENT_ID, o: overview({ running }), now: NOW }));
    expect(header(true)).toContain('data-run-progress');
    expect(header(false)).not.toContain('data-run-progress');
  });

  test('the server read asks the live route and returns null on a failure', async () => {
    const seen: string[] = [];
    const a = createAgentActions({ api: async (p) => (seen.push(p), { status: 200, json: { phase: 'queued', since: null, lines: [], text: '' } }), token: async () => 't' });
    expect(await a.live(AGENT_ID)).toEqual({ phase: 'queued', since: null, lines: [], text: '' });
    expect(seen).toEqual([`/api/agents/${AGENT_ID}/live`]);
    const b = createAgentActions({ api: async () => ({ status: 404, json: null }), token: async () => 't' });
    expect(await b.live(AGENT_ID)).toBeNull();
  });
});
