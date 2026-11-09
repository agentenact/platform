import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExploreNotice, SourceBlock } from '../../src/components/explore-body';
import type { Stats } from '../../src/lib/explore';

const stats: Stats = {
  network: 'testnet', agents: 92, provenOutputs: 0, usdcProven: '0', usdcTransfers: '1', activeLastHour: 0,
  asOf: '2026-10-14T18:57:01.000Z', indexedThrough: '2026-10-14T18:35:01.000Z', stale: false,
};
const html = (s: Stats | null) => renderToStaticMarkup(createElement(SourceBlock, { stats: s }));

describe('SourceBlock', () => {
  it('names network, registry, freshness and a current status', () => {
    const out = html({ ...stats, asOf: '2026-10-14T18:35:05.000Z' });
    expect(out).toContain('Stellar testnet');
    expect(out).toContain('stellar-8004 · CDE3K4CO…FIWZH');
    expect(out).toContain('18:35:01 UTC');
    expect(out).toContain('>Current<');
  });
  it('turns the status into an accent warning with the minutes behind when stale', () => {
    const out = html({ ...stats, stale: true });
    expect(out).toContain('Paused, 22 min behind');
    expect(out).toContain('ex-warn');
  });
  it('shows dashes while loading rather than a made-up time', () => {
    const out = html(null);
    expect(out).not.toContain('UTC');
    expect(out).not.toContain('Current');
  });
});

describe('SourceBlock when updates fail', () => {
  it('says not updating instead of Current after a failed poll with old numbers', () => {
    const out = renderToStaticMarkup(createElement(SourceBlock, { stats, failed: true }));
    expect(out).not.toContain('Current');
    expect(out).toContain('Not updating');
    expect(out).toContain('ex-warn');
  });
});

describe('ExploreNotice', () => {
  const out = (s: Stats | null, failed: boolean) =>
    renderToStaticMarkup(createElement(ExploreNotice, { stats: s, failed, onRetry: () => {} }));
  it('keeps the last numbers and names the time they are as of', () => {
    const o = out(stats, true);
    expect(o).toContain('role="status"');
    expect(o).toContain('Can’t refresh');
    expect(o).toContain('18:35 UTC');
    expect(o).not.toContain('<button');
  });
  it('shows a plain error with a retry when the first load failed', () => {
    const o = out(null, true);
    expect(o).toContain('role="status"');
    expect(o).toContain('Retry');
    expect(o).toContain('<button');
  });
  it('shows nothing while loading or when all is well', () => {
    expect(out(null, false)).toBe('');
    expect(out(stats, false)).toBe('');
  });
});
