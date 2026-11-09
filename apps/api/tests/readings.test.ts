import { describe, expect, it } from 'bun:test';
import { callLine, readingOf } from '../src/checks/readings.js';
import { bannedWord } from '../src/builder/words.js';
import { CONDITION_FETCH_TOOLS } from '../src/specs/schema.js';

const ACCT = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
// Shapes copied from what the real tools return (src/tools/chain.ts, payments.ts, market.ts).
const CHANGE = { symbol: 'XLM', network: 'mainnet', windowSeconds: 3600, from: { usd: '0.19214', at: '2026-10-13T10:00:00.000Z' }, to: { usd: '0.19133', at: '2026-10-13T11:00:00.000Z' }, changePct: -0.42 };
const PRICE = { symbol: 'XLM', usd: '0.1913', at: '2026-10-13T11:00:00.000Z', ageSeconds: 40, network: 'mainnet', source: 'reflector-pubnet', sdex: { pair: 'XLM/USDC (mainnet SDEX)', bid: '0.1912', ask: '0.1914' } };
const pay = (amount: string, asset: string, i: number) => ({ id: String(i), at: '2026-10-13T11:00:00Z', direction: 'in', kind: 'payment', from: ACCT, to: ACCT, asset, amount, tx: 'a'.repeat(64) });
const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const PAYMENTS = { account: ACCT, network: 'mainnet', payments: [pay('45.5000000', USDC, 1), pay('120.0000000', USDC, 2), pay('3.2500000', USDC, 3)], truncated: false };
const ACCOUNT = { exists: true, id: ACCT, sequence: '123', balances: [{ asset: 'XLM', balance: '1234.5000000' }, { asset: USDC, balance: '50.0000000' }, { asset: 'LP:abc', balance: '1.0000000' }] };

describe('readingOf', () => {
  it('stellar_price_change: reading and a line with a true minus sign', () => {
    expect(readingOf('stellar_price_change', { symbol: 'XLM', window_s: 3600 }, CHANGE)).toEqual({
      reading: { symbol: 'XLM', changePct: -0.42, from: 0.19214, to: 0.19133 },
      line: 'XLM moved −0.42% in the last hour',
    });
  });
  it('stellar_price_change: a rise has a plus, other windows are said in plain words', () => {
    expect(readingOf('stellar_price_change', {}, { ...CHANGE, changePct: 1.5, windowSeconds: 1800 }).line).toBe('XLM moved +1.50% in the last 30 minutes');
    expect(readingOf('stellar_price_change', {}, { ...CHANGE, windowSeconds: 21_600 }).line).toBe('XLM moved −0.42% in the last 6 hours');
    expect(readingOf('stellar_price_change', {}, { ...CHANGE, changePct: 0 }).line).toBe('XLM moved 0.00% in the last hour');
  });
  it('stellar_price and market_price: symbol and price', () => {
    expect(readingOf('stellar_price', { symbol: 'XLM' }, PRICE)).toEqual({ reading: { symbol: 'XLM', price: 0.1913 }, line: 'XLM is at $0.1913' });
    expect(readingOf('market_price', { ids: ['stellar'] }, { prices: { stellar: 0.1913 }, source: 'defillama' })).toEqual({ reading: { symbol: 'XLM', price: 0.1913 }, line: 'XLM is at $0.1913' });
    expect(readingOf('stellar_price', {}, { ...PRICE, symbol: 'BTC', usd: '67432.1' }).line).toBe('BTC is at $67,432.10');
  });
  it('market_price: unknown ids read as plain names', () => {
    expect(readingOf('market_price', { ids: ['the-open-network'] }, { prices: { 'the-open-network': 5 } })).toEqual({ reading: { symbol: 'the-open-network', price: 5 }, line: 'The Open Network is at $5.00' });
    expect(readingOf('market_price', { ids: ['constructor'] }, { prices: { constructor: 5 } }).line).toBe('Constructor is at $5.00');
  });
  it('a stale price is not presented as a current move', () => {
    const r = readingOf('stellar_price_change', {}, { ...CHANGE, stale: true });
    expect(r.line).toBe('XLM price is out of date, last seen \u22120.42% in the last hour');
    expect(r.line).not.toContain('moved');
    expect(r.reading).toMatchObject({ stale: 1 });
  });
  it('rejects absurd numbers (jsonb prints them in full) but keeps zero', () => {
    for (const bad of [1e300, 1e16, 1e-300, 1e-10]) expect(readingOf('stellar_price', {}, { symbol: 'XLM', usd: String(bad) })).toEqual({ reading: null, line: null });
    expect(readingOf('stellar_price', {}, { symbol: 'XLM', usd: '0' }).reading).toEqual({ symbol: 'XLM', price: 0 });
  });
  it('payments: strict amount and asset code', () => {
    for (const amount of ['0x10', '1e5', ' 12 ', '-3', '1.']) expect(readingOf('stellar_payments', {}, { payments: [pay(amount, 'XLM', 1)] })).toEqual({ reading: null, line: null });
    expect(readingOf('stellar_payments', {}, { payments: [pay('1.0000000', `BAD CODE!:${ACCT}`, 1)] })).toEqual({ reading: null, line: null });
  });
  it('size is counted in bytes', () => {
    const balances = Array.from({ length: 6 }, (_, i) => ({ asset: `A${i}:${ACCT}`, balance: '999999999999999.1234567' }));
    const r = readingOf('stellar_read', {}, { exists: true, id: ACCT, balances });
    expect(Buffer.byteLength(JSON.stringify(r.reading))).toBeLessThanOrEqual(400);
  });
  it('market_price: the first id that has a price', () => {
    expect(readingOf('market_price', { ids: ['nope', 'bitcoin'] }, { prices: { nope: null, bitcoin: 67000 }, source: 'mixed' }).reading).toEqual({ symbol: 'BTC', price: 67000 });
    expect(readingOf('market_price', { ids: ['nope'] }, { prices: { nope: null } })).toEqual({ reading: null, line: null });
  });
  it('stellar_payments: count and the largest', () => {
    expect(readingOf('stellar_payments', { account: ACCT }, PAYMENTS)).toEqual({ reading: { count: 3, largest: '120 USDC' }, line: '3 payments, the largest 120 USDC' });
    expect(readingOf('stellar_payments', {}, { ...PAYMENTS, payments: [pay('2.5000000', 'XLM', 1)] }).line).toBe('1 payment of 2.5 XLM');
    expect(readingOf('stellar_payments', {}, { ...PAYMENTS, payments: [] })).toEqual({ reading: { count: 0 }, line: 'No payments' });
  });
  it('stellar_read: a balance per asset and a shortened account, never the full address', () => {
    const r = readingOf('stellar_read', { kind: 'account', id: ACCT }, ACCOUNT);
    expect(r.reading).toEqual({ account: 'GBZX…MADI', XLM: 1234.5, USDC: 50 });
    expect(r.line).toBe('GBZX…MADI holds 1234.5 XLM and 50 USDC');
    expect(JSON.stringify(r)).not.toContain(ACCT);
  });
  it('stellar_read: a missing account or a transaction read gives nothing', () => {
    expect(readingOf('stellar_read', {}, { exists: false })).toEqual({ reading: null, line: null });
    expect(readingOf('stellar_read', {}, { exists: true, hash: 'a'.repeat(64), successful: true })).toEqual({ reading: null, line: null });
  });
  it('malformed or missing data gives nulls and never throws', () => {
    const bad: unknown[] = [null, undefined, 5, 'x', [], {}, { prices: 3 }, { payments: 'x' }, { payments: [null] }, { changePct: 'x' }, { symbol: 'XLM', usd: 'abc' }, { exists: true, id: 'short', balances: [1] }, { get symbol(): string { throw new Error('boom'); } }];
    for (const tool of CONDITION_FETCH_TOOLS) for (const d of bad) expect(readingOf(tool, undefined, d)).toEqual({ reading: null, line: null });
    expect(readingOf('nope' as never, {}, PRICE)).toEqual({ reading: null, line: null });
  });
  it('a BigInt or cyclic value does not throw', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(readingOf('stellar_price', {}, cyc)).toEqual({ reading: null, line: null });
    expect(readingOf('stellar_price', {}, { symbol: 'XLM', usd: 10n })).toEqual({ reading: null, line: null });
  });
  it('a reading stays within the table cap even with many odd balances', () => {
    const balances = Array.from({ length: 50 }, (_, i) => ({ asset: `A${'B'.repeat(10)}${i}:${ACCT}`.slice(0, 12) + `:${ACCT}`, balance: '123456789.1234567' }));
    const r = readingOf('stellar_read', {}, { exists: true, id: ACCT, balances });
    expect(Buffer.byteLength(JSON.stringify(r.reading))).toBeLessThanOrEqual(512);
    const long = readingOf('stellar_payments', {}, { payments: [pay('1.0000000', `${'C'.repeat(12)}:${ACCT}`, 1)] });
    expect(Buffer.byteLength(JSON.stringify(long.reading))).toBeLessThanOrEqual(512);
  });
  it('no line carries a banned word, and an odd asset code drops the line, not the reading', () => {
    for (const r of [readingOf('stellar_price_change', {}, CHANGE), readingOf('stellar_price', {}, PRICE), readingOf('stellar_payments', {}, PAYMENTS), readingOf('stellar_read', {}, ACCOUNT)]) expect(bannedWord(r.line!)).toBeNull();
    const odd = readingOf('stellar_payments', {}, { payments: [pay('5.0000000', `TOKEN:${ACCT}`, 1)] });
    expect(odd.line).toBeNull();
    expect(odd.reading).toEqual({ count: 1, largest: '5 TOKEN' });
  });
  it('no line or reading holds an email or a raw argument', () => {
    const r = readingOf('stellar_payments', { account: ACCT, secret: 'hunter2' }, PAYMENTS);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|@|GBZXN7/);
  });
});

describe('callLine', () => {
  const SENT = { sent: true };
  it('writes a plain line per tool and never the raw arguments', () => {
    expect(callLine('send_email', { subject: 'XLM fell 5%', text: 'body with secrets' }, SENT)).toBe('Emailed you: "XLM fell 5%"');
    expect(callLine('web_search', { query: 'stellar news today', count: 5 }, { results: [] })).toBe('Searched the web for "stellar news today"');
    expect(callLine('web_read', { url: 'https://user:pw@example.com:8443/a/b?token=abc#x' }, { text: 'x' })).toBe('Read a page on example.com');
    expect(callLine('compute', { code: 'return 1' }, 1)).toBe('Worked something out');
    expect(callLine('send_webhook', { text: 'x' }, SENT)).toBe('Called your webhook');
    expect(callLine('remember', { key: 'k', value: 'v' }, {})).toBe('Made a note for next time');
    expect(callLine('load_skill', { name: 'x' }, {})).toBeNull();
    expect(callLine('mystery', {}, {})).toBeNull();
  });
  it('says "tried" unless the result says it was sent', () => {
    expect(callLine('send_email', { subject: 'Hi' }, {})).toBe('Tried to email you');
    expect(callLine('send_email', { subject: 'Hi' }, { sent: false })).toBe('Tried to email you');
    expect(callLine('send_webhook', { text: 'x' }, {})).toBe('Tried to call your webhook');
    expect(callLine('send_webhook', { text: 'x' }, 'ok')).toBe('Tried to call your webhook');
  });
  it('hire_agent claims payment only when it settled', () => {
    expect(callLine('hire_agent', {}, { status: 200, payment: 'settled', paid_usdc: '0.0010000' })).toBe('Paid another agent for help (0.001 USDC on testnet)');
    expect(callLine('hire_agent', {}, { status: 200, payment: 'settled', paid_usdc: 'lots' })).toBe('Paid another agent for help');
    expect(callLine('hire_agent', {}, { error: 'hire_failed_after_payment', payment: 'unknown', paid_usdc: '0.001' })).toBe('Asked another agent for help (payment not confirmed)');
    expect(callLine('hire_agent', {}, { status: 500, payment: 'unknown' })).toBe('Asked another agent for help (payment not confirmed)');
    expect(callLine('hire_agent', {}, { status: 200, payment: 'none', paid_usdc: null })).toBe('Asked another agent for help');
    expect(callLine('hire_agent', {}, { error: 'verify_failed', payment: 'none' })).toBe('Tried to get help from another agent');
    expect(callLine('hire_agent', {}, { status: 502, payment: 'none' })).toBe('Tried to get help from another agent');
    expect(callLine('hire_agent', {}, null)).toBe('Asked another agent for help');
  });
  it('reuses the check line for the condition-fetch tools', () => {
    expect(callLine('stellar_price_change', { symbol: 'XLM', window_s: 3600 }, CHANGE)).toBe('XLM moved −0.42% in the last hour');
    expect(callLine('stellar_price', { symbol: 'XLM' }, PRICE)).toBe('XLM is at $0.1913');
    expect(callLine('stellar_price', { symbol: 'XLM' }, { weird: 1 })).toBeNull();
  });
  it('quotes only plain words: an allowlist', () => {
    const mail = (subject: unknown) => callLine('send_email', { subject }, SENT);
    expect(mail("It's a (big) win, 50% up!")).toBe('Emailed you: "It\'s a (big) win, 50% up!"');
    expect(mail('Paid $12.5 to Zoë – done')).toBe('Emailed you: "Paid $12.5 to Zoë – done"');
    const hostile = [
      'bob@example.com', 'bob＠example.com', 'evil.com/x?k=v', 'visit evil.com', 'password is hunter2', 'sk-abc1', 'GABCDEFGHIJKLMNOPQRSTUVWXYZ23456',
      'GABCDEFGHIJKLMNOP QRSTUVWXYZ23456', 'deadbeefdeadbeefdeadbeef', 'a1b2', 'x'.repeat(21), 'ab '.repeat(25), 'https://x', '1234567', '12.34567', 'a_b', 'bob/alice', '[x]', 'a<b>',
    ];
    for (const h of hostile) expect(mail(h)).toBe('Emailed you');
    for (const h of hostile) expect(callLine('web_search', { query: h }, {})).toBe('Searched the web');
    expect(mail('Your token is ready')).toBe('Emailed you');
    expect(mail(42)).toBe('Emailed you');
  });
  it('strips zero-width and bidi controls before checking, and clips to 60', () => {
    expect(callLine('send_email', { subject: 'hi\u200b there\u202e\u2066\ufeff' }, SENT)).toBe('Emailed you: "hi there"');
    expect(callLine('send_email', { subject: 'bob\u200b@example.com' }, SENT)).toBe('Emailed you');
    expect(callLine('send_email', { subject: 'line\nbreak\u0000' }, SENT)).toBe('Emailed you: "line break"');
    const long = callLine('web_search', { query: 'ab '.repeat(70) }, {})!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toBe('Searched the web');
    expect(callLine('web_search', { query: 'ab '.repeat(20).trim() }, {})).toBe(`Searched the web for "${'ab '.repeat(20).trim()}"`);
  });
  it('web_read keeps only a short plain hostname', () => {
    const read = (url: string) => callLine('web_read', { url }, {});
    expect(read('https://www.Example.com/x')).toBe('Read a page on www.example.com');
    for (const u of [
      `https://${'gabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst'}.evil.com/`, `https://${'a1'.repeat(19)}.evil.com`, 'https://abcdef012345.example.com', 'https://169.254.169.254/x',
      'https://[::1]/x', 'https://a.b.c.d.e.com', 'https://1abc.com', 'https://xn--bcher-kva.example', `https://${'a'.repeat(26)}.com`, 'ftp://example.com', 'not a url',
    ]) expect(read(u)).toBe(u.startsWith('https://xn--') ? 'Read a page on xn--bcher-kva.example' : 'Read a web page');
  });
});
