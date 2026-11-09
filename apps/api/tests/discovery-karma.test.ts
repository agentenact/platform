import { describe, expect, it } from 'bun:test';
import { createKarma, KARMA_BASE, PAYMENTS_PER_MIN } from '../src/discovery/karma.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const MIN = 60_000;

const row = (agentId: number, o: Record<string, unknown> = {}) => ({
  rank: agentId,
  address: `G${'A'.repeat(55)}`,
  chain: 'stellar-testnet',
  agentId,
  displayName: 'Third-party name',
  imageUrl: 'https://example.com/x.png',
  providerScore: 87,
  trustTier: 'Very Good',
  payments: { received: 2, usdcReceived: '0.0030000', lastReceivedAt: '2026-10-14T17:59:52+00:00' },
  ...o,
});
const page = (wallets: unknown[], total = wallets.length, offset = 0) => ({ network: 'testnet', total, count: wallets.length, offset, limit: 100, wallets });

/** A fetch that answers by path prefix and records every url it was asked for. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const path = url.slice(KARMA_BASE.length);
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) return new Response('{}', { status: 404 });
    return hit[1]();
  }) as typeof fetch;
  return { f, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(routes: Record<string, () => Response | Promise<Response>>, o: { maxAgeMs?: number } = {}) {
  let t = NOW.getTime();
  const { f, urls } = fakeFetch(routes);
  const k = createKarma({ fetch: f, now: () => new Date(t), sleep: async () => {}, ...(o.maxAgeMs !== undefined ? { maxAgeMs: o.maxAgeMs } : {}) });
  return { k, urls, advance: (ms: number) => (t += ms) };
}

describe('karma snapshot', () => {
  it('is unavailable before the first refresh', () => {
    const { k } = setup({});
    expect(k.view().available).toBe(false);
    expect(k.view().asOf).toBeNull();
    expect(k.view().facts(1)).toBeNull();
  });

  it('maps a stellar-testnet row to payment facts and score, and keeps no third-party name or image', async () => {
    const { k, urls } = setup({ '/api/explore/agents': () => json(page([row(10)])) });
    await k.refresh();
    expect(urls).toEqual([`${KARMA_BASE}/api/explore/agents?chain=stellar-testnet&limit=100&offset=0`]);
    const v = k.view();
    expect([v.available, v.asOf]).toEqual([true, NOW.toISOString()]);
    expect(v.facts(10)).toEqual({ paymentsReceived: 2, usdcReceived: '0.003', lastPaymentAt: '2026-10-14T17:59:52.000Z', score: 87, tier: 'Very Good' });
    expect(JSON.stringify(v.facts(10))).not.toMatch(/Third-party|example\.com/);
    expect(v.facts(11)).toBeNull(); // not on AgentKarma
  });

  it('pages until total', async () => {
    const first = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const { k, urls } = setup({
      '/api/explore/agents?chain=stellar-testnet&limit=100&offset=0': () => json(page(first, 102, 0)),
      '/api/explore/agents?chain=stellar-testnet&limit=100&offset=100': () => json(page([row(101), row(102)], 102, 100)),
    });
    await k.refresh();
    expect(urls).toHaveLength(2);
    expect(k.view().facts(102)?.paymentsReceived).toBe(2);
  });

  it('formats usdc like the rest of the api: trailing zeros trimmed, whole numbers bare', async () => {
    const { k } = setup({
      '/api/explore/agents': () =>
        json(page([row(1, { payments: { received: 0, usdcReceived: '0', lastReceivedAt: null } }), row(2, { payments: { received: 3, usdcReceived: '20.0000000', lastReceivedAt: '2026-10-01T00:00:00Z' } })])),
    });
    await k.refresh();
    expect(k.view().facts(1)).toMatchObject({ paymentsReceived: 0, usdcReceived: '0', lastPaymentAt: null });
    expect(k.view().facts(2)?.usdcReceived).toBe('20');
  });

  it('a null score or tier stays null', async () => {
    const { k } = setup({ '/api/explore/agents': () => json(page([row(1, { providerScore: null, trustTier: null })])) });
    await k.refresh();
    expect(k.view().facts(1)).toMatchObject({ score: null, tier: null });
  });

  it('refuses rows of another chain: the filter must have been applied', async () => {
    const { k } = setup({ '/api/explore/agents': () => json(page([row(1, { chain: 'solana' })])) });
    await expect(k.refresh()).rejects.toThrow();
    expect(k.view().available).toBe(false);
  });

  it('refuses a row without payment totals instead of showing zeros', async () => {
    const { k } = setup({ '/api/explore/agents': () => json(page([row(1, { payments: undefined })])) });
    await expect(k.refresh()).rejects.toThrow();
    expect(k.view().available).toBe(false);
  });

  it('refuses a malformed amount or count', async () => {
    for (const payments of [
      { received: 1, usdcReceived: '1e3', lastReceivedAt: null },
      { received: -1, usdcReceived: '1', lastReceivedAt: null },
      { received: 1.5, usdcReceived: '1', lastReceivedAt: null },
      { received: 1, usdcReceived: '1', lastReceivedAt: 'yesterday' },
    ]) {
      const { k } = setup({ '/api/explore/agents': () => json(page([row(1, { payments })])) });
      await expect(k.refresh()).rejects.toThrow();
    }
  });

  it('a failed refresh keeps the last snapshot until it is older than maxAge, then reports unavailable', async () => {
    let fail = false;
    const { k, advance } = setup({ '/api/explore/agents': () => (fail ? json({ error: 'x' }, 503) : json(page([row(1)]))) }, { maxAgeMs: 10 * MIN });
    await k.refresh();
    fail = true;
    advance(5 * MIN);
    await expect(k.refresh()).rejects.toThrow();
    expect(k.view()).toMatchObject({ available: true, asOf: NOW.toISOString() });
    expect(k.view().facts(1)).not.toBeNull();
    advance(6 * MIN);
    expect(k.view().available).toBe(false);
    expect(k.view().asOf).toBe(NOW.toISOString()); // "since" the last good snapshot
    expect(k.view().facts(1)).toBeNull(); // never serve figures past maxAge
  });

  it('retries a snapshot page once after a 5xx or a transport failure', async () => {
    let calls = 0;
    const { k, urls } = setup({ '/api/explore/agents': () => (++calls === 1 ? json({ error: 'x' }, 500) : json(page([row(1)]))) });
    await k.refresh();
    expect(urls.length).toBe(2);
    expect(k.view().available).toBe(true);
    calls = 0;
    urls.length = 0;
    const t = setup({ '/api/explore/agents': () => (++calls === 1 ? Promise.reject(new Error('The operation timed out.')) : json(page([row(1)]))) });
    await t.k.refresh();
    expect(t.urls.length).toBe(2);
  });

  it('never retries a 4xx, and gives up after the one retry', async () => {
    const bad = setup({ '/api/explore/agents': () => json({ error: 'x' }, 429) });
    await expect(bad.k.refresh()).rejects.toThrow('karma 429');
    expect(bad.urls.length).toBe(1);
    const down = setup({ '/api/explore/agents': () => json({ error: 'x' }, 503) });
    await expect(down.k.refresh()).rejects.toThrow('karma 503');
    expect(down.urls.length).toBe(2);
  });

  it('gives the snapshot page 30 s and a profile 10 s', async () => {
    const seen: number[] = [];
    const orig = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => (seen.push(ms), orig.call(AbortSignal, ms));
    try {
      const { k } = setup({ '/api/explore/agents': () => json(page([row(1)])), '/api/v2/agent': () => json({ payments: [] }) });
      await k.refresh();
      await k.payments(1);
    } finally {
      AbortSignal.timeout = orig;
    }
    expect(seen).toEqual([30_000, 10_000]);
  });

  it('a network error fails the refresh without touching the snapshot', async () => {
    const { k } = setup({ '/api/explore/agents': () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(k.refresh()).rejects.toThrow();
    expect(k.view().available).toBe(false);
  });
});

describe('karma payments for one agent', () => {
  const payRow = (id: string, o: Record<string, unknown> = {}) => ({ id, txHash: 'a'.repeat(64), from: `G${'P'.repeat(55)}`, amount: '0.0010000', timestamp: '2026-10-14T17:59:52+00:00', success: true, ...o });
  const body = (payments: unknown[]) => ({ chain: 'stellar-testnet', network: 'testnet', agentId: 90, address: `G${'A'.repeat(55)}`, payments, nextCursor: null });

  it('maps successful rows, newest first as given, with a per-op id', async () => {
    const { k, urls } = setup({
      '/api/v2/agent/stellar-testnet/90/payments': () => json(body([payRow('1:0'), payRow('1:1', { amount: '0.8000000' }), payRow('2:0', { success: false })])),
    });
    expect(await k.payments(90)).toEqual([
      { id: '1:0', at: '2026-10-14T17:59:52.000Z', amount: '0.001', payer: `G${'P'.repeat(55)}`, txHash: 'a'.repeat(64) },
      { id: '1:1', at: '2026-10-14T17:59:52.000Z', amount: '0.8', payer: `G${'P'.repeat(55)}`, txHash: 'a'.repeat(64) },
    ]);
    expect(urls).toEqual([`${KARMA_BASE}/api/v2/agent/stellar-testnet/90/payments?limit=50`]);
  });

  it('returns null when AgentKarma does not know the agent', async () => {
    const { k } = setup({ '/api/v2/agent/stellar-testnet/5/payments': () => json({ error: 'not_found' }, 404) });
    expect(await k.payments(5)).toBeNull();
  });

  it('throws when AgentKarma fails or answers garbage', async () => {
    const down = setup({ '/api/v2/agent/stellar-testnet/5/payments': () => json({ error: 'x' }, 429) });
    await expect(down.k.payments(5)).rejects.toThrow();
    const odd = setup({ '/api/v2/agent/stellar-testnet/5/payments': () => json(body([payRow('1:0', { amount: 'NaN' })])) });
    await expect(odd.k.payments(5)).rejects.toThrow();
    const noId = setup({ '/api/v2/agent/stellar-testnet/5/payments': () => json(body([payRow('1:0', { id: undefined })])) });
    await expect(noId.k.payments(5)).rejects.toThrow();
  });

  it('spends at most PAYMENTS_PER_MIN AgentKarma calls a minute on profiles, so the snapshot refresh keeps its share', async () => {
    const { k, urls, advance } = setup({ '/api/v2/agent/stellar-testnet/': () => json(body([payRow('1:0')])) });
    for (let id = 1; id <= PAYMENTS_PER_MIN; id++) await k.payments(id);
    expect(urls).toHaveLength(PAYMENTS_PER_MIN);
    await expect(k.payments(999)).rejects.toThrow('karma: budget'); // new id, no cached answer
    advance(31_000);
    expect(await k.payments(1)).toHaveLength(1); // over budget, an older cached answer is still served
    expect(urls).toHaveLength(PAYMENTS_PER_MIN);
    advance(30_000); // the minute has rolled
    await k.payments(999);
    expect(urls).toHaveLength(PAYMENTS_PER_MIN + 1);
  });

  it('caches one agent for 30 s so a busy profile spends one AgentKarma call', async () => {
    const { k, urls, advance } = setup({ '/api/v2/agent/stellar-testnet/90/payments': () => json(body([payRow('1:0')])) });
    await k.payments(90);
    await k.payments(90);
    expect(urls).toHaveLength(1);
    advance(31_000);
    await k.payments(90);
    expect(urls).toHaveLength(2);
  });
});
