import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentView, SellSlot } from '../src/components/agent-screen';
import { SellCardView } from '../src/components/sell-card';
import { copy } from '../src/copy';
import { asSellSuggestion } from '../src/lib/agent-types';
import { browserStorage, hiddenNow, hideForAWeek, HIDE_DAYS, initialSell, runOffer, type Offer, type OfferOut, type SellState } from '../src/lib/sell';
import type { ApiCall } from '../src/server/api';
import { createLoadSuggestion } from '../src/server/sell-data';
import { createSellActions } from '../src/server/sell-actions';
import { bannedWord } from '../src/lib/words';
import type { AgentLoad } from '../src/server/agent-data';
import { AGENT_ID, feed, NOW, overview } from './support/agent';
import { textOf } from './support/screens';

const answer = (over: Record<string, unknown> = {}) => ({
  eligible: true,
  suggestion: { version: 4, label: 'Sell my XLM price checks to other agents', service: { slug: 'xlm-check', price_usdc: '0.0100000', tools: [] }, ...over },
});
const shown = asSellSuggestion(answer())!;
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();
const view = (state: SellState = initialSell) => renderToStaticMarkup(createElement(SellCardView, { suggestion: shown, state }));

describe('what the card shows', () => {
  test('only an eligible answer with a suggestion is a card', () => {
    expect(shown).toEqual({ version: 4, label: 'Sell my XLM price checks to other agents', price: '0.01' });
    expect(asSellSuggestion({ eligible: false })).toBeNull();
    expect(asSellSuggestion({ eligible: true, suggestion: null, reason: 'daily_limit' })).toBeNull();
    expect(asSellSuggestion(null)).toBeNull();
    expect(asSellSuggestion(answer({ version: 0 }))).toBeNull();
    expect(asSellSuggestion(answer({ version: '4' }))).toBeNull();
    expect(asSellSuggestion(answer({ label: '' }))).toBeNull();
    expect(asSellSuggestion(answer({ service: { price_usdc: 'free' } }))).toBeNull();
  });

  test('the slot draws nothing for no suggestion, a daily limit or a failed read, and the card for a real one', async () => {
    const none = await SellSlot({ agentId: AGENT_ID, load: async () => null });
    expect(none).toBeNull();
    const card = await SellSlot({ agentId: AGENT_ID, load: async () => shown });
    expect(text(renderToStaticMarkup(card))).toContain(copy.sell.banner);
  });

  test('the agent page puts the offer below the feed, after the tabs, and has none without one', () => {
    const load = { kind: 'ready', id: AGENT_ID, overview: overview(), feed: feed() } as Extract<AgentLoad, { kind: 'ready' }>;
    const withCard = renderToStaticMarkup(createElement(AgentView, { load, now: NOW, sell: createElement(SellCardView, { suggestion: shown }) }));
    const t = text(withCard);
    expect(t.indexOf('checks today')).toBeLessThan(t.indexOf('Activity Chat'));
    expect(t.indexOf('Activity Chat')).toBeLessThan(t.indexOf('Offer it'));
    expect(withCard.indexOf('data-feed')).toBeLessThan(withCard.indexOf('data-sell'));
    expect(text(renderToStaticMarkup(createElement(AgentView, { load, now: NOW })))).not.toContain('Offer it');
  });

  test('shows the sentence, the suggested name, the price and both buttons', () => {
    const t = text(view());
    expect(t).toContain('Others could pay to use your agent. Want to offer it?');
    expect(t).toContain('Sell my XLM price checks to other agents');
    expect(t).toContain('0.01 USDC per use · testnet');
    expect(t).toContain('Offer it');
    expect(t).toContain('Not now');
    expect(view()).toContain('data-version="4"');
  });

  test('it is a one-line dashed banner with Not now and Offer it, not a panel', () => {
    const html = view();
    expect(html).toContain('border-dashed');
    expect(html).not.toContain('panel-sand');
    expect(html.indexOf('data-sell-price')).toBeLessThan(html.indexOf('data-not-now')); // the price is read before the buttons
    expect(html.slice(html.indexOf('data-sell-name') - 80, html.indexOf('data-sell-name'))).toContain('text-fg-2');
    expect(html.indexOf('data-not-now')).toBeLessThan(html.indexOf('data-offer'));
    expect(html).toMatch(/<button[^>]*data-variant="quiet"[^>]*data-offer|<button[^>]*data-offer[^>]*data-variant="quiet"/);
  });

  test('done, stale and busy states', () => {
    expect(text(view({ phase: 'done' }))).toBe('Done. Other agents can now find and pay for it.');
    expect(text(view({ phase: 'stale' }))).toBe(copy.sell.stale);
    expect(view({ phase: 'stale' })).not.toContain('data-offer');
    expect(view({ phase: 'hidden' })).toBe('');
    expect(view({ phase: 'card', busy: true, message: null })).toContain('disabled');
  });

  test('the words service and services never appear, in any state or in the copy', () => {
    for (const html of [view(), view({ phase: 'card', busy: true, message: null }), view({ phase: 'done' }), view({ phase: 'stale' })]) {
      expect(/services?/i.test(textOf(html))).toBe(false);
      expect(bannedWord(textOf(html))).toBeNull();
    }
    for (const s of Object.values(copy.sell).map((v) => (typeof v === 'function' ? v('0.01') : v))) expect(/services?/i.test(s)).toBe(false);
  });
});

describe('Offer it', () => {
  test('sends the shown version once and ends in the done sentence', async () => {
    const seen: number[] = [];
    const offer: Offer = async (v) => (seen.push(v), { ok: true });
    expect(await runOffer(offer, shown.version)).toEqual({ phase: 'done' });
    expect(seen).toEqual([4]);
  });

  test('a stale answer is a plain note, a failure keeps the card with a sentence, a throw is generic', async () => {
    expect(await runOffer(async () => ({ ok: false, stale: true }), 4)).toEqual({ phase: 'stale' });
    expect(await runOffer(async () => ({ ok: false, stale: false, message: copy.errors.status5xx }), 4)).toEqual({ phase: 'card', busy: false, message: copy.errors.status5xx });
    expect(await runOffer(() => Promise.reject(new Error('<html>boom</html>')), 4)).toEqual({ phase: 'card', busy: false, message: copy.errors.generic });
  });
});

describe('the server action', () => {
  const act = (res: { status: number; json: unknown }, seen: { path: string; body?: unknown; method?: string }[] = []) =>
    createSellActions({ api: (async (path, o) => (seen.push({ path: path.replace(AGENT_ID, ':id'), body: o?.body, method: o?.method }), res)) as ApiCall, token: async () => 't' });

  test('POSTs the shown version to publish; 204 is ok', async () => {
    const seen: { path: string; body?: unknown; method?: string }[] = [];
    expect(await act({ status: 204, json: null }, seen).offer(AGENT_ID, 4)).toEqual({ ok: true });
    expect(seen).toEqual([{ path: '/api/agents/:id/suggestion/publish', body: { version: 4 }, method: 'POST' }]);
  });

  test('409 not_eligible is stale; other failures are plain sentences chosen by status', async () => {
    expect(await act({ status: 409, json: { error: 'not_eligible' } }).offer(AGENT_ID, 4)).toEqual({ ok: false, stale: true });
    expect(await act({ status: 429, json: { error: 'rate_limited' } }).offer(AGENT_ID, 4)).toEqual({ ok: false, stale: false, message: copy.errors.rateLimited });
    expect(await act({ status: 503, json: null }).offer(AGENT_ID, 4)).toEqual({ ok: false, stale: false, message: copy.errors.status5xx });
    expect(await act({ status: 502, json: null }).offer(AGENT_ID, 4)).toEqual({ ok: false, stale: false, message: copy.errors.status5xx });
  });

  test('a bad id or version and a missing session never reach the api', async () => {
    const seen: unknown[] = [];
    const a = createSellActions({ api: (async (p) => (seen.push(p), { status: 204, json: null })) as ApiCall, token: async () => undefined });
    expect((await a.offer('nope', 4)).ok).toBe(false);
    expect((await a.offer(AGENT_ID, 0)).ok).toBe(false);
    expect((await a.offer(AGENT_ID, 4)).ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('Not now', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  test('hides for 7 days, then the card is back', () => {
    const s = mem();
    const t0 = Date.parse('2026-10-13T12:00:00Z');
    expect(hiddenNow(s, AGENT_ID, t0)).toBe(false);
    hideForAWeek(s, AGENT_ID, t0);
    expect(hiddenNow(s, AGENT_ID, t0 + 1000)).toBe(true);
    expect(hiddenNow(s, AGENT_ID, t0 + (HIDE_DAYS * 86_400_000 - 1))).toBe(true);
    expect(hiddenNow(s, AGENT_ID, t0 + HIDE_DAYS * 86_400_000 + 1)).toBe(false);
    expect(hiddenNow(s, 'another-agent', t0 + 1000)).toBe(false);
  });
  test('without storage, or with storage that throws, nothing breaks and the card shows', () => {
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(() => hideForAWeek(null, AGENT_ID, 1)).not.toThrow();
    expect(() => hideForAWeek(boom, AGENT_ID, 1)).not.toThrow();
    expect(hiddenNow(null, AGENT_ID, 1)).toBe(false);
    expect(hiddenNow(boom, AGENT_ID, 1)).toBe(false);
    expect(hiddenNow(mem(), AGENT_ID, 1)).toBe(false);
    expect(browserStorage()).toBeNull(); // no window on the server
  });
  test('a damaged value is ignored', () => {
    const s = mem();
    s.setItem(`agentenact.sell.notnow.${AGENT_ID}`, 'soon');
    expect(hiddenNow(s, AGENT_ID, 1)).toBe(false);
  });
});

describe('reading the suggestion', () => {
  const load = (res: { status: number; json: unknown }, token: string | null = 't') => createLoadSuggestion({ token: async () => token ?? undefined, api: (async () => res) as ApiCall })(AGENT_ID);
  test('a real answer is a suggestion; everything else is null and never throws', async () => {
    expect(await load({ status: 200, json: answer() })).toEqual(shown);
    expect(await load({ status: 200, json: { eligible: true, suggestion: null, reason: 'daily_limit' } })).toBeNull();
    expect(await load({ status: 200, json: { eligible: false } })).toBeNull();
    for (const status of [401, 404, 429, 500, 503]) expect(await load({ status, json: null })).toBeNull();
    expect(await load({ status: 200, json: answer() }, null)).toBeNull();
    expect(await createLoadSuggestion({ token: async () => 't', api: () => Promise.reject(new Error('<html>')) })(AGENT_ID)).toBeNull();
  });
});
