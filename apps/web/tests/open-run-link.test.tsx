import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { AgentScreen } from '../src/components/agent-screen';
import type { RunDetail } from '../src/lib/agent-types';
import type { AgentLoad } from '../src/server/agent-data';

// The alert email's "See what I saw" link is /dashboard?run=<id>: the page opens that run's row with its details already loaded.
const AGENT_ID = '123e4567-e89b-12d3-a456-426614174000';
const RUN_ID = '0b9a7c2e-1d4f-4a6b-8c3d-5e6f7a8b9c0d';
const NOW = Date.parse('2026-10-13T12:30:00.000Z');
const run: RunDetail = {
  id: RUN_ID, mode: 'mission', status: 'done', stopReason: 'done',
  steps: [{ n: 1, tools: ['send_email'], inputTokens: 200, outputTokens: 40, finishReason: 'stop' }],
  inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 1,
  usdcSpent: '0.0010000', usdcEarned: '0.0000000', settlementTx: null, summary: 'XLM fell 5.8% in an hour.', model: null,
  triggerId: null, serviceId: null, startedAt: '2026-10-13T12:00:00.000Z', endedAt: '2026-10-13T12:00:07.400Z',
} as RunDetail;
const items = [
  { type: 'alert' as const, at: '2026-10-13T12:00:07Z', runId: RUN_ID, text: 'XLM fell 5.8% in an hour.' },
  { type: 'problem' as const, at: '2026-10-12T07:00:00Z', runId: 'other-run' },
];

describe('opening a run from a link', () => {
  test('the linked row starts open with its details; other rows stay closed', () => {
    const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items, opened: { runId: RUN_ID, out: { ok: true, run } } }));
    const rows = html.split('<li ').slice(1);
    expect(rows[0]).toContain('aria-expanded="true"');
    expect(rows[0]).not.toMatch(/<div id="[^"]*" hidden/);
    expect(rows[1]).toContain('aria-expanded="false"');
  });

  test('the page loads the run named in ?run= on the server, and ignores a malformed value', async () => {
    const calls: string[] = [];
    const loadRun = async (_agentId: string, runId: string) => (calls.push(runId), { ok: true as const, run });
    const load = async (): Promise<AgentLoad> => ({ kind: 'ready', id: AGENT_ID, overview: { status: 'watching' } as never, feed: items } as AgentLoad);
    await AgentScreen({ id: AGENT_ID, load, now: NOW, searchParams: { run: RUN_ID }, loadRun }).catch(() => null);
    expect(calls).toEqual([RUN_ID]);
    calls.length = 0;
    for (const bad of ['../admin', 'x', [RUN_ID, RUN_ID]]) await AgentScreen({ id: AGENT_ID, load, now: NOW, searchParams: { run: bad }, loadRun }).catch(() => null);
    expect(calls).toEqual([]);
  });
});
