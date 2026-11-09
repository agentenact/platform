import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fetchProfile, parseId, ProfileView } from '../../src/components/agent-profile';
import type { AgentProfile } from '../../src/lib/explore';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const REF = 'ab'.repeat(32);
const TX = 'cd'.repeat(32);
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OWNER = 'GABGUOWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNSVL73';
const WALLET = 'GDO73WALLETWALLETWALLETWALLETWALLETWALLETWALLETWALLETAWECM';
const PAYER = 'GCH36PAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPANKNZ3';

const profile = (o: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 46, owner: OWNER, wallet: WALLET, builder: 'hosted',
  registered: { at: '2026-10-01T08:00:00.000Z', txHash: TX, source: 'event' },
  lastActiveAt: '2026-10-12T09:00:00.000Z',
  totals: { paymentsReceived: 2, usdcReceived: '0.002', provenSales: 1 },
  history: [
    { id: 'a:0', at: '2026-10-12T09:00:00.000Z', amount: '0.001', payer: PAYER, txHash: TX, proof: { ref: REF, agentUuid: UUID } },
    { id: 'b:0', at: '2026-10-11T09:00:00.000Z', amount: '0.001', payer: PAYER, txHash: 'ee'.repeat(32), proof: null },
  ],
  payments: { source: 'agentkarma', available: true, asOf: '2026-10-12T09:58:00.000Z' },
  karma: null,
  selfPublished: {
    name: 'Pixel Poet', description: 'Writes haiku',
    services: [{ slug: 'haiku', description: 'A haiku', priceUsdc: '0.001' }], fetchedAt: '2026-10-12T09:00:00.000Z',
  },
  hidden: false, links: { karma: 'x' }, ...o,
});
const html = (p: AgentProfile) => renderToStaticMarkup(createElement(ProfileView, { profile: p, now: NOW }));
const advanced = (out: string) => /<details[\s\S]*<\/details>/.exec(out)![0];

describe('ProfileView', () => {
  it('shows history with proof for sales and payment links otherwise', () => {
    const out = html(profile());
    expect(out).toContain('proof ↗');
    expect(out).toContain(`/verify?agent=${UUID}&amp;tx=${REF}`);
    expect(out).toContain('payment ↗');
    expect(out).toContain(`stellar.expert/explorer/testnet/tx/${'ee'.repeat(32)}`);
    expect(out).toContain('0.001 USDC from');
    expect(out).toContain('GCH3…KNZ3'.slice(0, 5));
    expect(out).toContain(`title="${PAYER}"`);
    expect(out.indexOf('1h')).toBeLessThan(out.indexOf('1d')); // newest first, as given
  });

  it('names AgentKarma as the source of the payment history', () => {
    expect(html(profile())).toContain('Payments as indexed by AgentKarma.');
  });

  it('lists two payments of one transaction as two lines', () => {
    const p = profile({
      history: [
        { id: 'x:0', at: '2026-10-12T09:00:00.000Z', amount: '0.2', payer: PAYER, txHash: TX, proof: null },
        { id: 'x:1', at: '2026-10-12T09:00:00.000Z', amount: '0.8', payer: PAYER, txHash: TX, proof: null },
      ],
    });
    const out = html(p);
    expect(out).toContain('0.2 USDC from');
    expect(out).toContain('0.8 USDC from');
  });

  it('says payments are unavailable since when, instead of an empty history, when AgentKarma is down', () => {
    const out = html(profile({ history: null, payments: { source: 'agentkarma', available: false, asOf: '2026-10-12T09:12:00.000Z' }, totals: { paymentsReceived: null, usdcReceived: null, provenSales: 1 } }));
    expect(out).toContain('Payments from AgentKarma are unavailable since 09:12 UTC.');
    expect(out).not.toContain('No payments yet.');
    expect(out).toContain('Agent #46'); // our own data still renders
  });

  it('shows the AgentKarma score in Ratings when there is one', () => {
    const rated = html(profile({ karma: { score: 87, tier: 'Very Good' } }));
    const ratings = rated.slice(rated.indexOf('aria-label="Ratings"'));
    expect(ratings).toContain('AgentKarma score 87 · Very Good');
    expect(html(profile({ karma: { score: 0, tier: 'Unrated' } }))).not.toContain('AgentKarma score');
  });

  it('shows the empty history state', () => {
    expect(html(profile({ history: [] }))).toContain('No payments yet.');
  });

  it('puts owner and address only inside the Advanced details', () => {
    const out = html(profile());
    const adv = advanced(out);
    expect(adv).toContain('Advanced');
    expect(adv).toContain('Owner and address');
    expect(adv).toContain('GABG…');
    expect(adv).toContain(`title="${OWNER}"`);
    expect(adv).toContain(`title="${WALLET}"`);
    // Visible text outside the details (the ratings link href carries the owner, but is not shown).
    const outside = out.replace(adv, '').replace(/<[^>]*>/g, ' ');
    expect(outside).not.toContain('GABG');
    expect(outside).not.toContain('GDO7');
    expect(out.replace(adv, '')).not.toContain(WALLET);
  });

  it('marks self-published text and keeps chain fields unmarked', () => {
    const out = html(profile());
    expect(out.match(/self-published/g)?.length).toBe(3); // name, description, services heading
    expect(advanced(out)).not.toContain('self-published');
    const hist = out.slice(out.indexOf('aria-label="History"'), out.indexOf('aria-label="Ratings"'));
    expect(hist).not.toContain('self-published');
  });

  it('shows ask the agent for a missing price', () => {
    const p = profile();
    p.selfPublished!.services = [{ slug: 'haiku', description: null, priceUsdc: null }];
    const out = html(p);
    expect(out).toContain('price: ask the agent');
    expect(out).not.toContain('USDC</li>');
  });

  it('hidden profile shows no name or services', () => {
    const out = html(profile({ hidden: true }));
    expect(out).toContain('Details hidden by the AgentEnact team.');
    expect(out).not.toContain('Pixel Poet');
    expect(out).not.toContain('Services');
    expect(out).not.toContain('haiku');
    expect(out).toContain('Agent #46');
  });

  it('escapes hostile names and descriptions', () => {
    const bad = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const p = profile();
    p.selfPublished = { name: bad, description: bad, services: [{ slug: bad, description: bad, priceUsdc: null }], fetchedAt: 'x' };
    const out = html(p);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('contains the no-correctness footnote and no word good/correct/quality outside it', () => {
    const out = html(profile());
    const foot = 'A proof shows who was paid, by whom, and for what amount. It does not say the output was good.';
    expect(out).toContain(foot);
    expect(out.replace(foot, '')).not.toMatch(/good|correct|quality/i);
  });

  it('falls back to the registry record without a registration tx, and tags external agents', () => {
    const out = html(profile({ builder: 'external', registered: { at: null, txHash: null, source: 'registry_read' }, selfPublished: null }));
    expect(out).toContain('registry record #46');
    expect(out).toContain('>external<');
    expect(out).not.toContain('Services');
    expect(out).toContain('See ratings on AgentKarma ↗');
  });
});

describe('parseId', () => {
  it('accepts 1-10 digits only', () => {
    expect(parseId('46')).toBe(46);
    expect(parseId('0')).toBe(0);
    for (const bad of [null, '', '-1', '4.6', '46a', '12345678901', '1e3', ' 46', '../x', '46/../../x']) expect(parseId(bad)).toBeNull();
  });
});

describe('fetchProfile', () => {
  const resp = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('returns null on 404 and throws on other failures', async () => {
    expect(await fetchProfile(9, { fetch: resp(404, { error: 'not_found' }) })).toBeNull();
    expect(fetchProfile(9, { fetch: resp(500, {}) })).rejects.toThrow();
    expect((await fetchProfile(46, { fetch: resp(200, profile()) }))?.id).toBe(46);
  });
});
