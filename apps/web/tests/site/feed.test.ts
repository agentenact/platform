import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedBody, FeedList, FEED_CAP, mergeFeed } from '../../src/components/feed';
import type { FeedItem } from '../../src/lib/explore';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const REF = 'a'.repeat(64);
const TX = 'b'.repeat(64);
const UUID = '123e4567-e89b-12d3-a456-426614174000';

const item = (o: Partial<FeedItem>): FeedItem => ({
  seq: 1, kind: 'paid', at: '2026-10-12T09:59:00.000Z', agentId: 45, builder: 'hosted', otherAgentId: 46,
  amount: '0.001', label: null, selfPublished: false, link: null, ...o,
});
const text = (m: string) => m.replace(/<[^>]*>/g, '').replace(/\\s+/g, ' ');
const html = (items: FeedItem[]) => renderToStaticMarkup(createElement(FeedList, { items, now: NOW }));

describe('FeedList', () => {
  it('renders a paid line with a proof link', () => {
    const out = html([item({ link: { type: 'proof', ref: REF, agentUuid: UUID } })]);
    expect(text(out)).toContain('Agent #46 paid #45 0.001 USDC');
    expect(out).toContain('>proof · aaaaaaaa…aaaaaa ↗<');
    expect(out).toContain('href="/agents/46"');
    expect(out).toContain('href="/agents/45"');
    expect(out).toContain(`href="/verify?agent=${UUID}&amp;tx=${REF}"`);
    expect(out).toContain('>1m<');
  });

  it('links a library proof to the public record url', () => {
    const out = html([item({ link: { type: 'proof', ref: REF, agentUuid: null } })]);
    expect(out).toContain('verify?record=');
    expect(out).toContain(REF);
  });

  it('renders the someone-paid variant with a payment link', () => {
    const out = html([item({ otherAgentId: null, link: { type: 'payment', txHash: TX } })]);
    expect(text(out)).toContain('Someone paid agent #45 0.001 USDC');
    expect(out).toContain('>payment · bbbbbbbb…bbbbbb ↗<');
    expect(out).toContain('aria-label="payment transaction bbbbbbbb…bbbbbb"');
    expect(out).toContain(`https://stellar.expert/explorer/testnet/tx/${TX}`);
  });

  it('renders registered with the builder tag and registry record text when there is no link', () => {
    const out = html([item({ kind: 'registered', agentId: 1284, builder: 'library', amount: null, otherAgentId: null, link: null })]);
    expect(text(out)).toContain('New agent #1284 registered');
    expect(out).toContain('Built on AgentEnact');
    expect(out).toContain('registry record');
    expect(out).not.toContain('class="ex-hash"');
  });

  it('links a registration to its transaction and marks it lighter than a payment', () => {
    const out = html([item({ kind: 'registered', builder: 'external', amount: null, otherAgentId: null, link: { type: 'registration', txHash: TX } })]);
    expect(out).toContain('>registration · bbbbbbbb…bbbbbb ↗<');
    expect(out).toContain('class="ex-ln ex-reg"');
    expect(html([item({})])).toContain('class="ex-ln ex-pay"');
  });

  it('puts a machine-readable time on every line', () => {
    expect(html([item({})])).toContain('dateTime="2026-10-12T09:59:00.000Z"');
  });

  it('omits the builder tag for external agents', () => {
    expect(html([item({ kind: 'registered', builder: 'external', amount: null, otherAgentId: null })])).not.toContain('Built on AgentEnact');
  });

  it('renders service_opened with the self-published badge', () => {
    const out = html([item({ kind: 'service_opened', agentId: 902, amount: null, otherAgentId: null, label: 'Haiku', selfPublished: true })]);
    expect(text(out)).toContain('Agent #902 opened a service: “Haiku”');
    expect(out).toContain('self-published');
  });

  it('escapes hostile labels', () => {
    const out = html([item({ kind: 'service_opened', amount: null, otherAgentId: null, label: '<script>alert(1)</script>', selfPublished: true })]);
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script');
  });

  it('does not throw on a malformed proof ref, it just drops the link', () => {
    const out = html([item({ link: { type: 'proof', ref: 'nope', agentUuid: null } })]);
    expect(text(out)).toContain('Agent #46 paid #45');
    expect(out).not.toContain('class="ex-hash"');
  });

  it('shows the empty state', () => {
    expect(html([])).toContain('No activity yet. When an agent is paid or registered, it shows here.');
  });
});

describe('mergeFeed', () => {
  it('merges by seq, newest first, and keeps the newer copy', () => {
    const a = item({ seq: 1, at: '2026-10-12T09:00:00.000Z' });
    const b = item({ seq: 2, at: '2026-10-12T09:30:00.000Z' });
    const b2 = { ...b, amount: '9' };
    const out = mergeFeed([a, b], [b2]);
    expect(out.map((i) => i.seq)).toEqual([2, 1]);
    expect(out[0]!.amount).toBe('9');
  });

  it('caps at 100 lines and drops the oldest', () => {
    const many = Array.from({ length: 130 }, (_, i) => item({ seq: i + 1, at: new Date(Date.UTC(2026, 9, 12, 0, 0, i)).toISOString() }));
    const out = mergeFeed([], many);
    expect(out.length).toBe(FEED_CAP);
    expect(out[0]!.seq).toBe(130);
    expect(out.at(-1)!.seq).toBe(31);
  });
});

describe('FeedBody live region', () => {
  const body = (data: FeedItem[] | null, error: boolean) =>
    renderToStaticMarkup(createElement(FeedBody, { data, error, shown: 12, now: NOW }));
  it('never wraps the list in aria-live, so relative times are not re-announced', () => {
    const out = body([item({})], false);
    expect(out).toContain('<ul');
    expect(out).not.toContain('aria-live');
  });
  it('announces only the loading, error and reconnect messages', () => {
    expect(body(null, true)).toContain('aria-live="polite"');
    expect(body([item({})], true)).toContain('Reconnecting');
    expect(body([item({})], true)).toMatch(/aria-live="polite"[^>]*>Reconnecting|Reconnecting/);
    expect(body([], false)).toContain('aria-live="polite"');
  });
});
