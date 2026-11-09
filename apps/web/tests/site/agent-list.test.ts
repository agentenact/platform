import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentCards, EmptySearch, PaymentsNote, createQueryGate } from '../../src/components/agent-list';
import type { AgentCard, PaymentsSource } from '../../src/lib/explore';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const card = (o: Partial<AgentCard>): AgentCard => ({
  id: 45, builder: 'hosted', selfPublished: null, paymentsReceived: 7, usdcReceived: '0.007', provenSales: 3,
  lastActiveAt: '2026-10-12T09:00:00.000Z', lastPaymentAt: '2026-10-12T09:25:00.000Z', karma: null, ...o,
});
const UP: PaymentsSource = { source: 'agentkarma', available: true, asOf: '2026-10-12T09:58:00.000Z' };
const DOWN: PaymentsSource = { source: 'agentkarma', available: false, asOf: '2026-10-12T09:12:00.000Z' };
const html = (items: AgentCard[], payments?: PaymentsSource) => renderToStaticMarkup(createElement(AgentCards, { items, now: NOW, payments }));

describe('AgentCards', () => {
  it('an agent for hire without a published price: price: ask the agent', () => {
    const out = html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: null } }, hire: { priceUsdc: null } })]);
    expect(out).toContain('>For hire<');
    expect(out).toContain('price: ask the agent');
    expect(out).toContain('“haiku”');
    expect(out).toContain('self-published');
  });

  it('an agent for hire shows its lowest price', () => {
    const out = html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: '0.001' } }, hire: { priceUsdc: '0.001' } })]);
    expect(out).toContain('>For hire<');
    expect(out).toContain('<b>0.001</b> USDC');
    expect(out).toContain('title="Price per call"');
    expect(out).not.toContain('ask the agent');
  });

  it('an endpoint that is not for hire is listed, never sold', () => {
    const out = html([card({ selfPublished: { name: 'Site', service: { slug: 'web', description: null, priceUsdc: null } }, hire: null })]);
    expect(out).toContain('lists “web”');
    expect(out).not.toContain('For hire');
    expect(out).not.toContain('sells');
  });

  it('an older api without the hire field: a priced service still reads as for hire', () => {
    const out = html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: '0.5' } } })]);
    expect(out).toContain('>For hire<');
    expect(out).toContain('<b>0.5</b> USDC');
    expect(html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: null } } })])).not.toContain('For hire');
  });

  it('says no public services without a service', () => {
    expect(html([card({})])).toContain('no public services');
  });

  it('tags AgentEnact agents (hosted and library alike), and names external ones only for screen readers', () => {
    expect(html([card({ builder: 'library' })])).toContain('title="Built on AgentEnact">AgentEnact<');
    expect(html([card({ builder: 'hosted' })])).toContain('title="Built on AgentEnact">AgentEnact<');
    const ext = html([card({ builder: 'external' })]);
    expect(ext).toContain('<span class="sr-only">external</span>');
    expect(ext).not.toContain('Built on AgentEnact');
  });

  it('shows the id beside a self-published name, and the id is the name otherwise', () => {
    const out = html([card({ id: 82, selfPublished: { name: 'Pixel Poet', service: null } })]);
    expect(out).toContain('<span class="ex-aid">#82</span>');
    expect(out).toContain('“Pixel Poet”');
    const plain = html([card({ id: 91, builder: 'external' })]);
    expect(plain).toContain('Agent #91');
    expect(plain).not.toContain('ex-aid');
  });

  it('falls back to Agent #id without a name', () => {
    expect(html([card({ id: 77 })])).toContain('Agent #77');
    expect(html([card({ id: 78, selfPublished: { name: null, service: null } })])).toContain('Agent #78');
  });

  it('uses the self-published name when present', () => {
    expect(html([card({ selfPublished: { name: 'Pixel Poet', service: null } })])).toContain('Pixel Poet');
  });

  it('marks a self-published name and not a fallback name', () => {
    const own = html([card({ selfPublished: { name: 'Pixel Poet', service: null } })]);
    expect(own.match(/self-published/g)?.length).toBe(1);
    expect(html([card({ id: 77 })])).not.toContain('self-published');
    expect(html([card({ id: 78, selfPublished: { name: null, service: null } })])).not.toContain('self-published');
  });

  it('links to /agents/<id>', () => {
    expect(html([card({ id: 45 })])).toContain('href="/agents/45"');
  });

  it('shows earned USDC with the payment count for every agent, and proofs in their own column', () => {
    const ext = html([card({ builder: 'external', paymentsReceived: 7, provenSales: 0 })]);
    expect(ext).toContain('<b>0.007</b> USDC');
    expect(ext).toContain('>7 payments<');
    const ae = html([card({ builder: 'hosted', provenSales: 3 })]);
    expect(ae).toContain('<b>3</b>');
    expect(ae).toContain('title="3 proven outputs"');
    expect(ae).toContain('>proven<');
  });

  it('gets the plurals right', () => {
    expect(html([card({ builder: 'hosted', provenSales: 1 })])).toContain('title="1 proven output"');
    expect(html([card({ builder: 'external', paymentsReceived: 1 })])).toContain('>1 payment<');
    expect(html([card({ provenSales: 1 })])).toContain('> proof<');
    expect(html([card({ provenSales: 2 })])).toContain('> proofs<');
  });

  it('says no payments received for an external agent with none', () => {
    expect(html([card({ builder: 'external', paymentsReceived: 0, usdcReceived: '0' })])).toContain('no payments received');
  });

  it('shows the last payment received age', () => {
    expect(html([card({})])).toContain('last payment received 35m');
  });

  it('says payments are unavailable (not zero) when AgentKarma is down, and keeps our proven outputs', () => {
    const ext = html([card({ builder: 'external', paymentsReceived: null, usdcReceived: null, lastPaymentAt: null })], DOWN);
    expect(ext).toContain('payments unavailable');
    expect(ext).not.toContain('no payments received');
    expect(ext).not.toContain('last payment');
    expect(html([card({ builder: 'hosted', provenSales: 2, paymentsReceived: null, usdcReceived: null })], DOWN)).toContain('2 proven outputs');
  });

  it('says not on AgentKarma yet when it is up but has no record of the agent', () => {
    const ext = html([card({ builder: 'external', paymentsReceived: null, usdcReceived: null, lastPaymentAt: null })], UP);
    expect(ext).toContain('not on AgentKarma yet');
    expect(ext).not.toContain('no payments received');
  });

  it('shows the AgentKarma score and tier when there is one, a dash when unrated or absent', () => {
    const text = (m: string) => m.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text(html([card({ karma: { score: 87, tier: 'Very Good' } })]))).toContain('AgentKarma 87 Very Good');
    expect(text(html([card({ karma: { score: 87.4, tier: null } })]))).toMatch(/AgentKarma 87(?![\d.])/);
    for (const karma of [null, { score: null, tier: null }, { score: 0, tier: 'Unrated' }]) expect(html([card({ karma })])).not.toContain('AgentKarma');
    const legacy = card({});
    delete (legacy as Partial<AgentCard>).karma; // an older api build sends no karma field
    expect(html([legacy])).not.toContain('AgentKarma');
  });

  it('shows no last-payment text when the field is missing or null, and never borrows lastActiveAt', () => {
    const missing = card({});
    delete missing.lastPaymentAt;
    expect(html([missing])).not.toContain('last payment');
    expect(html([card({ lastPaymentAt: null })])).not.toContain('last payment');
    expect(html([missing])).not.toContain('active 1h');
  });

  it('escapes hostile names and slugs', () => {
    const out = html([card({ selfPublished: { name: '<script>x</script>', service: { slug: '<img onerror=1>', description: null, priceUsdc: null } } })]);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
  });
});

describe('PaymentsNote', () => {
  const out = (p?: PaymentsSource) => renderToStaticMarkup(createElement(PaymentsNote, { payments: p })).replace(/<[^>]*>/g, '');
  it('names AgentKarma as the source of card payments and says the transfers total is ours', () => {
    const o = out(UP);
    expect(o).toContain('Payments on these cards are AgentKarma’s index, as of 09:58 UTC.');
    expect(o).toContain('payments.csv');
  });
  it('says what is missing and since when when AgentKarma is unavailable', () => {
    expect(out(DOWN)).toContain('Payments from AgentKarma are unavailable since 09:12 UTC. Agents and proven outputs are shown from AgentEnact’s own index.');
    expect(out({ source: 'agentkarma', available: false, asOf: null })).toContain('Payments from AgentKarma are unavailable right now.');
  });
  it('renders nothing for an older api build that does not say', () => {
    expect(out(undefined)).toBe('');
  });
});

describe('EmptySearch', () => {
  const out = (q: string, total?: number) => renderToStaticMarkup(createElement(EmptySearch, { query: q, total }));
  it('echoes the query as text, says what search covers and offers a way out', () => {
    const o = out('stellar dex', 92);
    expect(o).toContain('No agents match “stellar dex”.');
    expect(o).toContain('Search looks at names, services and ids such as #46.');
    expect(o).toContain('clear the search to see all 92.');
    expect(o).toContain('>Clear search<');
  });
  it('escapes a hostile query', () => {
    const o = out('<script>alert(1)</script>');
    expect(o).not.toContain('<script');
    expect(o).toContain('&lt;script&gt;');
  });
  it('does not invent a total', () => {
    expect(out('x')).toContain('to see all agents.');
  });
});

describe('createQueryGate', () => {
  it('accepts a response only for the latest query', () => {
    const g = createQueryGate();
    const a = g.begin('foo');
    expect(g.isCurrent(a)).toBe(true);
    const b = g.begin('bar');
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it('a load-more started for an old query is stale once the query changes', () => {
    const g = createQueryGate();
    g.begin('');
    const more = g.begin('');
    g.begin('x');
    expect(g.isCurrent(more)).toBe(false);
  });
});

describe('agent list sort and filters', () => {
  it('reads a view from the url and drops anything unknown', async () => {
    const { viewFromParams, viewParams, DEFAULT_VIEW } = await import('../../src/lib/explore');
    expect(viewFromParams(new URLSearchParams(''))).toEqual(DEFAULT_VIEW);
    const v = viewFromParams(new URLSearchParams('q=bot&sort=paid&built=agentenact&hire=1&paid=1'));
    expect(v).toEqual({ q: 'bot', sort: 'paid', built: 'agentenact', hire: true, paid: true });
    expect(viewParams(v).toString()).toBe('q=bot&sort=paid&built=agentenact&hire=1&paid=1');
    // the earlier sells=1 link opens the hire list
    expect(viewParams(viewFromParams(new URLSearchParams('sells=1'))).toString()).toBe('hire=1');
    expect(viewFromParams(new URLSearchParams('sort=cheapest&built=hosted&sells=yes&hire=true'))).toEqual(DEFAULT_VIEW);
    expect(viewParams(DEFAULT_VIEW).toString()).toBe('');
  });

  it('summarises the list by what is shown, matched and how it is ordered', async () => {
    const { listSummary } = await import('../../src/components/agent-list');
    const { DEFAULT_VIEW } = await import('../../src/lib/explore');
    expect(listSummary(DEFAULT_VIEW, 20, 121, undefined)).toBe('20 of 121 shown · latest activity first');
    expect(listSummary({ ...DEFAULT_VIEW, sort: 'paid' }, 20, 121, 121)).toBe('20 of 121 shown · most paid first');
    expect(listSummary({ ...DEFAULT_VIEW, hire: true }, 3, 121, 3)).toBe('3 of 3 matching · latest activity first');
    expect(listSummary({ ...DEFAULT_VIEW, q: 'bot' }, 2, 121, undefined)).toBe('2 of 121 shown');
  });

  it('marks pressed chips and the chosen sort', async () => {
    const { AgentControls } = await import('../../src/components/agent-list');
    const { DEFAULT_VIEW } = await import('../../src/lib/explore');
    const out = renderToStaticMarkup(createElement(AgentControls, { view: { ...DEFAULT_VIEW, sort: 'karma', hire: true }, onChange: () => {} }));
    expect(out.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(out).toContain('aria-pressed="true" class="ex-chip">For hire<');
    expect(out).toContain('<option value="karma" selected="">AgentKarma</option>');
  });

  it('counts sealed actions as proofs and says what they are', () => {
    const only = html([card({ provenSales: 0, seals: 142 })]);
    expect(only).toContain('<b>142</b>');
    expect(only).toContain('title="142 actions sealed"');
    expect(only).toContain('>sealed<');
    const both = html([card({ provenSales: 2, seals: 5 })]);
    expect(both).toContain('<b>7</b>');
    expect(both).toContain('title="2 proven outputs · 5 actions sealed"');
    expect(both).toContain('>2 sold · 5 sealed<');
    expect(html([card({ provenSales: 0, seals: 0 })])).not.toContain('sealed');
  });
});
