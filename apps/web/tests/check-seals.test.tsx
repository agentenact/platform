import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFeed } from '../src/components/activity-feed';
import { copy } from '../src/copy';
import { asFeed } from '../src/lib/agent-types';
import { bannedWord } from '../src/lib/words';
import type { ApiCall } from '../src/server/api';
import { createSealsDownload } from '../src/server/seals-download';
import { AGENT_ID, NOW } from './support/agent';
import { textOf } from './support/screens';

const TX = 'ab'.repeat(32);
const base = { type: 'quiet' as const, at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 266 };
const seals = { total: 266, sent: 266, failed: 0, last: { hash: TX, network: 'stellar:testnet' } };
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();

describe('sealed checks in the feed', () => {
  test('asFeed keeps seals only when the counts add up and a landed one is named exactly when something landed', () => {
    expect(asFeed([{ ...base, seals }])![0]).toEqual({ ...base, seals });
    expect(asFeed([{ ...base, seals: { ...seals, sent: 0, last: null } }])![0]).toEqual({ ...base, seals: { ...seals, sent: 0, last: null } });
    for (const bad of [{ ...seals, sent: 300 }, { ...seals, failed: 1 }, { ...seals, last: null }, { ...seals, sent: 0 }, { ...seals, last: { hash: 'x', network: 'stellar:testnet' } }, { ...seals, total: -1 }, 'yes']) {
      expect(asFeed([{ ...base, seals: bad }])![0]).toEqual(base);
    }
  });

  test('the day row says how many checks are sealed, links the newest on the explorer, and offers the day\'s proofs', () => {
    const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ ...base, seals }] }));
    const t = text(html);
    expect(t).toContain('266 of 266 checks sealed on chain');
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX}"`);
    expect(html).toContain(`href="/dashboard/${AGENT_ID}/seals/2026-10-13"`);
    expect(html).toContain('download="checks-2026-10-13.json"');
    expect(bannedWord(t)).toBeNull();
    expect(bannedWord(copy.activity.txNote)).toBeNull();
    expect(bannedWord(copy.activity.proofsTitle)).toBeNull();
  });

  test('checks still on their way, and ones that gave up, are said plainly', () => {
    const pending = text(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ ...base, seals: { total: 10, sent: 8, failed: 0, last: seals.last } }] })));
    expect(pending).toContain('8 of 10 checks sealed on chain, the rest on the way');
    const failed = text(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ ...base, seals: { total: 10, sent: 8, failed: 2, last: seals.last } }] })));
    expect(failed).toContain('8 of 10 checks sealed on chain, 2 could not be sealed');
    const none = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [base] }));
    expect(none).not.toContain('data-sealed');
    expect(none).not.toContain('data-tx');
  });
});

describe('sealed decisions in the feed', () => {
  const alert = { type: 'alert' as const, at: '2026-10-13T11:55:00Z', text: 'XLM dropped 6%.', runId: '00000000-0000-4000-8000-000000000001' };
  const DTX = 'cd'.repeat(32);
  const sent = { status: 'sent', tx: { hash: DTX, network: 'stellar:testnet' } };

  test('asFeed keeps a decision only when landed means it names its transaction', () => {
    expect(asFeed([{ ...alert, decision: sent }])![0]).toEqual({ ...alert, decision: sent } as never);
    expect(asFeed([{ ...alert, decision: { status: 'pending', tx: null } }])![0]).toEqual({ ...alert, decision: { status: 'pending', tx: null } });
    for (const bad of [{ status: 'sent', tx: null }, { status: 'pending', tx: sent.tx }, { status: 'done', tx: null }, { status: 'sent', tx: { hash: 'x', network: 'stellar:testnet' } }, 'yes']) {
      expect(asFeed([{ ...alert, decision: bad }])![0]).toEqual(alert);
    }
    expect(asFeed([{ type: 'problem', at: alert.at, decision: sent }])![0]).toEqual({ type: 'problem', at: alert.at, decision: sent } as never);
  });

  test('an alert row says its decision is sealed and links the seal beside what it paid', () => {
    const pay = { hash: 'ef'.repeat(32), network: 'eip155:84532', usdc: '0.01' };
    const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ ...alert, payments: [pay], decision: sent } as never] }));
    const t = text(html);
    expect(t).toContain('Decision sealed on chain');
    expect(html).toContain('data-decision="sent"');
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${DTX}"`);
    expect(html).toContain(`href="https://sepolia.basescan.org/tx/0x${'ef'.repeat(32)}"`);
    expect(bannedWord(t)).toBeNull();
    for (const w of [copy.activity.decisionSealed, copy.activity.decisionSealing, copy.activity.decisionFailed, copy.activity.decisionTitle]) expect(bannedWord(w)).toBeNull();
  });

  test('a decision on its way or given up is said plainly, with nothing to link', () => {
    for (const [status, words] of [['pending', 'Sealing the decision'], ['failed', 'The decision could not be sealed']] as const) {
      const html = renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [{ ...alert, decision: { status, tx: null } }] }));
      expect(text(html)).toContain(words);
      expect(html).not.toContain('data-tx');
    }
    expect(renderToStaticMarkup(createElement(ActivityFeed, { agentId: AGENT_ID, now: NOW, items: [alert] }))).not.toContain('data-decision');
  });
});

describe('the proofs download', () => {
  const answer = { seals: [{ at: '2026-10-13T00:01:00.000Z', status: 'sent', digest: 'cd'.repeat(32), tx: TX, document: '{"a":1}' }] };
  const api = (status = 200, json: unknown = answer): { api: ApiCall; calls: string[] } => {
    const calls: string[] = [];
    return { calls, api: (async (path: string, o?: { token?: string }) => (calls.push(`${path} ${o?.token}`), { status, json })) as ApiCall };
  };

  test('the owner gets the day as a JSON attachment with the exact documents', async () => {
    const a = api();
    const res = await createSealsDownload({ token: async () => 'tok', api: a.api })(AGENT_ID, '2026-10-13');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="checks-2026-10-13.json"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { day: string; checks: unknown[] };
    expect(body.day).toBe('2026-10-13');
    expect(body.checks).toEqual(answer.seals);
    expect(a.calls).toEqual([`/api/agents/${AGENT_ID}/seals/2026-10-13 tok`]);
  });

  test('signed out, a bad address, or someone else\'s agent gets nothing', async () => {
    const a = api();
    expect((await createSealsDownload({ token: async () => undefined, api: a.api })(AGENT_ID, '2026-10-13')).status).toBe(401);
    expect((await createSealsDownload({ token: async () => 't', api: a.api })('nope', '2026-10-13')).status).toBe(404);
    expect((await createSealsDownload({ token: async () => 't', api: a.api })(AGENT_ID, '13-10-2026')).status).toBe(404);
    expect(a.calls).toEqual([]);
    expect((await createSealsDownload({ token: async () => 't', api: api(404, null).api })(AGENT_ID, '2026-10-13')).status).toBe(404);
  });
});
