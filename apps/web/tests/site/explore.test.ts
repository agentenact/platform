import { describe, expect, test } from 'bun:test';
import {
  API_BASE, createPoller, exportUrl, formatUsdc, getJson, isRateLimited, karmaUrl, nextDelay, paymentUrl, proofUrl, shortId, timeAgo,
} from '../../src/lib/explore';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const REF = 'a'.repeat(64);
const UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('formatUsdc', () => {
  const t: [string, string][] = [
    ['213.4', '213.4'], ['0.001', '0.001'], ['1234.5', '1,234.5'], ['0', '0'], ['1000000', '1,000,000'],
    ['1234567.1234567', '1,234,567.1234567'], ['0.0000001', '0.0000001'], ['-1234.5', '-1,234.5'],
    ['99999999999999999999.1234567', '99,999,999,999,999,999,999.1234567'], ['-5000', '-5,000'],
  ];
  for (const [i, o] of t) test(`${i}`, () => expect(formatUsdc(i)).toBe(o));
  test('never scientific', () => expect(formatUsdc('0.00000001')).not.toMatch(/e/i));
});

describe('timeAgo', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  const t: [number, string][] = [[0, 'now'], [4, 'now'], [5, '5s'], [12, '12s'], [60, '1m'], [120, '2m'], [3 * 3600, '3h'], [2 * 86400, '2d'], [-30, 'now']];
  for (const [s, o] of t) test(`${s}s`, () => expect(timeAgo(ago(s), now)).toBe(o));
  test('garbage', () => expect(timeAgo('nope', now)).toBe(''));
});

test('shortId', () => expect(shortId(46)).toBe('#46'));

describe('links', () => {
  test('hosted proof', () => expect(proofUrl({ ref: REF, agentUuid: UUID })).toBe(`/verify?agent=${UUID}&tx=${REF}`));
  test('library proof', () =>
    expect(proofUrl({ ref: REF, agentUuid: null })).toBe(`/verify?record=${encodeURIComponent(`${API_BASE}/public/records/${REF}`)}`));
  test('rejects bad ref / uuid', () => {
    expect(() => proofUrl({ ref: 'x&y=1', agentUuid: null })).toThrow();
    expect(() => proofUrl({ ref: REF.toUpperCase(), agentUuid: null })).toThrow();
    expect(() => proofUrl({ ref: REF, agentUuid: 'a&b' })).toThrow();
  });
  test('payment, export, karma', () => {
    expect(paymentUrl('abc')).toBe('https://stellar.expert/explorer/testnet/tx/abc');
    expect(paymentUrl('a/b?c')).toBe('https://stellar.expert/explorer/testnet/tx/a%2Fb%3Fc');
    expect(exportUrl('proven-sales')).toBe(`${API_BASE}/public/export/proven-sales.csv`);
    expect(karmaUrl('GABC')).toBe('https://agentkarma.io/agent/GABC');
  });
});

describe('getJson', () => {
  const fake = (r: Response) => (async () => r) as unknown as typeof fetch;
  test('200', async () => expect(await getJson<unknown>('/x', { fetch: fake(Response.json({ a: 1 })) })).toEqual({ a: 1 }));
  test('500 throws', async () => expect(getJson('/x', { fetch: fake(new Response('no', { status: 500 })) })).rejects.toThrow('500'));
  test('429 carries retry-after', async () => {
    const e = (await getJson('/x', { fetch: fake(new Response('', { status: 429, headers: { 'retry-after': '7' } })) }).catch((x: unknown) => x)) as { retryAfterS: number };
    expect(isRateLimited(e)).toBe(true);
    expect(e.retryAfterS).toBe(7);
  });
  test('429 without header defaults', async () => {
    const e = (await getJson('/x', { fetch: fake(new Response('', { status: 429 })) }).catch((x: unknown) => x)) as { retryAfterS: number };
    expect(e.retryAfterS).toBe(60);
  });
});

describe('polling', () => {
  test('backoff', () => {
    expect(nextDelay(5000, false)).toBe(5000);
    expect(nextDelay(5000, true)).toBe(20000);
  });

  function harness(load: (s: AbortSignal) => Promise<number>, opts: { hidden?: () => boolean } = {}) {
    const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
    const out = { data: [] as number[], errors: 0 };
    const p = createPoller<number>({
      load, everyMs: 1000, isHidden: opts.hidden ?? (() => false),
      onData: (v) => out.data.push(v), onError: () => out.errors++,
      setTimer: (fn, ms) => { const t = { fn, ms, id: timers.length, live: true }; timers.push(t); return t; },
      clearTimer: (t) => { (t as { live: boolean }).live = false; },
    });
    const fire = async () => { const t = timers.filter((x) => x.live).at(-1)!; t.live = false; t.fn(); await sleep(0); };
    return { p, timers, out, fire };
  }

  test('runs now, schedules after completion, never overlaps', async () => {
    let calls = 0;
    let release!: () => void;
    const h = harness(() => { calls++; return new Promise<number>((r) => (release = () => r(calls))); });
    h.p.start();
    h.p.start();
    h.p.wake();
    expect(calls).toBe(1);
    expect(h.timers.length).toBe(0); // nothing scheduled while in flight
    release();
    await sleep(0);
    expect(h.out.data).toEqual([1]);
    expect(h.timers.map((t) => t.ms)).toEqual([1000]);
  });

  test('error backs off 4x, then recovers', async () => {
    let n = 0;
    const h = harness(async () => { if (n++ === 0) throw new Error('x'); return n; });
    h.p.start();
    await sleep(0);
    expect(h.out.errors).toBe(1);
    expect(h.timers[0]!.ms).toBe(4000);
    await h.fire();
    expect(h.out.data).toEqual([2]);
    expect(h.timers[1]!.ms).toBe(1000);
  });

  test('pauses while hidden, wakes on visible', async () => {
    let hidden = true;
    let calls = 0;
    const h = harness(async () => ++calls, { hidden: () => hidden });
    h.p.start();
    await sleep(0);
    expect(calls).toBe(0);
    expect(h.timers.length).toBe(0);
    hidden = false;
    h.p.wake();
    await sleep(0);
    expect(calls).toBe(1);
  });

  test('hides mid-schedule: timer fires, parks without loading', async () => {
    let hidden = false;
    let calls = 0;
    const h = harness(async () => ++calls, { hidden: () => hidden });
    h.p.start();
    await sleep(0);
    hidden = true;
    await h.fire();
    expect(calls).toBe(1);
    hidden = false;
    h.p.wake();
    await sleep(0);
    expect(calls).toBe(2);
  });

  test('stop aborts in-flight, drops result, clears timer', async () => {
    let sig!: AbortSignal;
    const h = harness((s) => { sig = s; return new Promise<number>((r) => setTimeout(() => r(9), 5)); });
    h.p.start();
    h.p.stop();
    expect(sig.aborted).toBe(true);
    await sleep(15);
    expect(h.out.data).toEqual([]);
    expect(h.timers.length).toBe(0);
  });
});

describe('resolveApiBase', () => {
  const { resolveApiBase, PROD_API } = require('../../src/lib/explore') as typeof import('../../src/lib/explore');
  test('dev honours the override', () => expect(resolveApiBase('development', 'http://localhost:8790/')).toBe('http://localhost:8790'));
  test('test env honours the override', () => expect(resolveApiBase(undefined, 'http://localhost:8790')).toBe('http://localhost:8790'));
  test('production ignores the override', () => expect(resolveApiBase('production', 'http://localhost:8790')).toBe(PROD_API));
  test('no override gives production api', () => expect(resolveApiBase('development', undefined)).toBe('https://api.agentenact.io'));
  test('prod api is the real host', () => expect(PROD_API).toBe('https://api.agentenact.io'));
});

describe('ledger helpers', () => {
  const { shortHash, utcTime, plural } = require('../../src/lib/explore') as typeof import('../../src/lib/explore');
  test('shortHash', () => expect(shortHash('64ffd2f5101faf543e07438239a21931aa36cddba2b5c08d1657136da2342ad2')).toBe('64ffd2f5…342ad2'));
  test('utcTime', () => {
    expect(utcTime('2026-10-14T18:35:01.000Z')).toBe('18:35:01 UTC');
    expect(utcTime('2026-10-14T18:35:01.000Z', false)).toBe('18:35 UTC');
    expect(utcTime(null)).toBeNull();
    expect(utcTime('nope')).toBeNull();
  });
  test('plural', () => {
    expect(plural(1, 'payment')).toBe('1 payment');
    expect(plural(0, 'payment')).toBe('0 payments');
  });
});
