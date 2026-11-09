import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Numbers, NumbersSkeleton, NumbersStrip, Overview } from '../../src/components/explore-numbers';
import type { Stats } from '../../src/lib/explore';

const stats: Stats = {
  network: 'testnet',
  agents: 1234,
  provenOutputs: 56,
  usdcProven: '12.5',
  usdcTransfers: '213.4',
  activeLastHour: 7,
  payments: 104,
  seals: 4119,
  asOf: '2026-10-12T10:00:00.000Z',
  indexedThrough: '2026-10-12T09:59:50.000Z',
  stale: false,
};

const html = (s: Stats, variant: 'strip' | 'full', stale = false) => renderToStaticMarkup(createElement(Numbers, { stats: s, variant, stale }));
const text = (m: string) => m.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('Numbers strip', () => {
  it('shows the four new labels and formatted values', () => {
    const out = html(stats, 'strip');
    for (const l of [
      'agents registered',
      'paid outputs with a proof',
      'USDC paid for proven outputs',
      'agents with payment activity, last hour',
    ]) {
      expect(out).toContain(l);
    }
    for (const v of ['1,234', '56', '12.5', '7']) expect(out).toContain(`>${v}<`);
    expect(out).not.toContain('213.4');
  });

  it('links to /explore, has no csv links and says Testnet', () => {
    const strip = html(stats, 'strip');
    expect(strip).toContain('href="/explore"');
    expect(strip).not.toContain('.csv');
    expect(strip).toContain('Testnet');
  });

  it('until the first proven sale, shows only the agent count (no row of zeros on the homepage)', () => {
    const out = html({ ...stats, agents: 92, provenOutputs: 0, usdcProven: '0', usdcTransfers: '146.3898', activeLastHour: 3 }, 'strip');
    expect(out).toContain('>92<');
    expect(out).toContain('agents registered');
    for (const gone of ['paid outputs with a proof', 'USDC paid for proven outputs', 'agents with payment activity', '146.3898', '>3<']) expect(out).not.toContain(gone);
    expect(out).toContain('href="/explore"');
    expect(out).toContain('Testnet');
  });

  it('before the first proven sale, shows the agent count with the seals and payments on chain', () => {
    const out = html({ ...stats, agents: 121, provenOutputs: 0, usdcProven: '0', usdcTransfers: '146.4418', activeLastHour: 0, payments: 104, seals: 4119 }, 'strip');
    for (const v of ['121', '4,119', '104']) expect(out).toContain(`>${v}<`);
    for (const l of ['agents registered', 'agent checks sealed on chain', 'payments to agents']) expect(out).toContain(l);
    expect(out).not.toContain('paid outputs with a proof');
  });

  it('leaves out a zero on-chain count, and both when the api does not send them', () => {
    const base = { ...stats, provenOutputs: 0, usdcProven: '0' };
    const zero = html({ ...base, seals: 0, payments: 3 }, 'strip');
    expect(zero).not.toContain('sealed on chain');
    expect(zero).toContain('payments to agents');
    const old = html({ ...base, seals: undefined, payments: undefined }, 'strip');
    expect(old).not.toContain('sealed on chain');
    expect(old).not.toContain('payments to agents');
    const full = html({ ...base, seals: undefined, payments: undefined }, 'full');
    expect(full.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)?.length).toBe(4);
  });

  it('leaves the seals to the hero once the api sends community counts, so the page never shows two seal totals', () => {
    const out = html({ ...stats, provenOutputs: 0, usdcProven: '0', community: { people: 9, agents: 4, seals: 120, txs: 300 } }, 'strip');
    expect(out).not.toContain('sealed on chain');
    expect(out).toContain('payments to agents');
  });

  it('shows 0, not blank, for an empty index', () => {
    const out = html({ ...stats, agents: 0, provenOutputs: 0, usdcProven: '0', usdcTransfers: '0', activeLastHour: 0 }, 'strip');
    expect(out).toContain('>0<');
  });


  it('NumbersStrip renders nothing without data', () => {
    expect(renderToStaticMarkup(createElement(NumbersStrip))).toBe('');
  });
});

describe('Numbers full (the ledger table)', () => {
  it('is a real table with four column heads and four rows', () => {
    const out = html(stats, 'full');
    expect(out).toContain('<table');
    for (const h of ['count', 'what it counts', 'how it is counted', 'download']) expect(out).toContain(`scope="col">${h}</th>`);
    expect(out.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)?.length).toBe(6);
  });

  it('carries the four labels and their definitions verbatim', () => {
    const t = text(html(stats, 'full'));
    for (const s of [
      'Agents registered',
      'Every agent in the stellar-8004 testnet registry.',
      'Paid outputs with a proof',
      'Enactment Records that checked out against the payment that bought the output.',
      'USDC paid for proven outputs',
      'Payments that settled a proven output. Nothing else counts.',
      'Agents with payment activity, last hour',
      'Agents that sent or received a payment, or sold a proven output, in the last 60 minutes.',
      'A record that fails a check is not listed.',
      'A payment no record points to is not in it.',
      'Registrations and wallet binds are left out. The window rolls.',
      'Definitions changed 14 Oct 2026.',
    ]) {
      expect(t).toContain(s);
    }
  });

  it('links a csv download on every row that has one (seals have none), each with a label naming its count', () => {
    const out = html(stats, 'full');
    for (const n of ['agents', 'proven-sales', 'payments', 'activity']) {
      expect(out).toContain(`href="https://api.agentenact.io/public/export/${n}.csv"`);
    }
    expect(out.match(/rows ↓/g)?.length).toBe(5);
    expect(out).toContain('aria-label="Download the rows behind USDC paid for proven outputs (CSV)"');
    expect(out).toContain('aria-label="Download the rows behind Payments to agents (CSV)"');
  });

  it('shows the proven figure as the count and the transfers on the labelled context line', () => {
    const out = html(stats, 'full');
    expect(out).toContain('<span class="ex-n">12.5</span>');
    expect(text(out)).toContain('Not part of the count: 213.4 USDC in transfers to agents from any sender');
  });


  it('renders zeros with their definition, a plain none-yet and what would change it', () => {
    const zero: Stats = { ...stats, provenOutputs: 0, usdcProven: '0', activeLastHour: 0 };
    const out = html(zero, 'full');
    const t = text(out);
    expect(out.match(/class="ex-none"/g)?.length).toBe(3);
    expect(t).toContain('None yet. This changes when an agent sells an output and its record verifies.');
    expect(out).toContain('href="/verify"');
    expect(t).toContain('none this hour');
    expect(t).toContain('No payment sent, received or sold since 09:00 UTC.');
    expect(t).toContain('proven-sales.csv · header only');
    expect(t).toContain('activity.csv · header only');
    // the definitions stay
    expect(t).toContain('Payments that settled a proven output. Nothing else counts.');
  });

  it('keeps the old transfers total out of the headline figure', () => {
    const zero: Stats = { ...stats, provenOutputs: 0, usdcProven: '0' };
    expect(html(zero, 'full')).toContain('<span class="ex-n">0</span><span class="ex-unit">USDC</span>');
  });

  it('names the as-of time in the first head only when stale', () => {
    expect(html(stats, 'full', false)).toContain('scope="col">count</th>');
    expect(html(stats, 'full', true)).toContain('scope="col">count · as of 09:59 UTC</th>');
  });
});

describe('NumbersSkeleton', () => {
  it('holds six muted rows with no animation or values', () => {
    const out = renderToStaticMarkup(createElement(NumbersSkeleton));
    expect(out.match(/data-skeleton-block/g)?.length).toBe(6);
    expect(out).toContain('aria-hidden');
    expect(out).not.toContain('animate');
    expect(out).not.toContain('rows');
  });
});

describe('Overview (the compact row on /explore)', () => {
  const ov = (s: Stats) => renderToStaticMarkup(createElement(Overview, { stats: s }));
  it('carries the four ledger labels with their figures and no csv links', () => {
    const out = ov(stats);
    for (const l of ['Agents registered', 'Paid outputs with a proof', 'USDC paid for proven outputs', 'Agents with payment activity, last hour']) expect(out).toContain(l);
    for (const v of ['1,234', '56', '12.5', '7']) expect(out).toContain(`>${v}<`);
    expect(out).not.toContain('.csv');
    expect(out).not.toContain('none yet');
  });
  it('marks zeros as none yet instead of a bare large zero', () => {
    const out = ov({ ...stats, provenOutputs: 0, usdcProven: '0', activeLastHour: 0 });
    expect(out.match(/none yet/g)?.length).toBe(2);
    expect(out).toContain('none this hour');
    expect(out.match(/ex-ovz/g)?.length).toBe(3);
  });
});
