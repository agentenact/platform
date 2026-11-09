import { describe, expect, it } from 'bun:test';
import { createHorizonReader, createRateLimiter, transfersOf } from '../src/chain/horizon.js';
import {
  LOOKALIKE_ISSUER,
  OWNER,
  PAYER,
  USDC,
  WALLET,
  classicPayment,
  horizonPage,
  jsonResponse,
  queueFetch,
  sorobanTransfer,
  usdcChange,
} from './support/fake-chain.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const noSleep = async () => {};
const reader = (responses: Parameters<typeof queueFetch>[0]) => {
  const q = queueFetch(responses);
  return { ...q, r: createHorizonReader({ horizonUrl: 'https://horizon-testnet.stellar.org/', fetch: q.fetch, retry: { sleep: noSleep } }) };
};

describe('transfersOf', () => {
  it('reads a classic payment', () => {
    const [t] = transfersOf(classicPayment({ id: '100', hash: H1, amount: '0.0010000' }));
    expect(t).toEqual({ opId: '100', idx: 0, txHash: H1, from: PAYER, to: WALLET, amountUnits: 10000n, asset: USDC, at: '2026-10-12T10:00:00Z' });
  });

  it('reads native XLM as XLM and a path payment like a payment', () => {
    const xlm = classicPayment({ id: '1', hash: H1, asset: { asset_type: 'native' } });
    expect(transfersOf(xlm)[0]!.asset).toBe('XLM');
    expect(transfersOf({ ...xlm, type: 'path_payment_strict_receive' })).toHaveLength(1);
  });

  it('reads a Soroban transfer from asset_balance_changes and ignores mint/burn entries', () => {
    const rec = sorobanTransfer({
      id: '200',
      hash: H1,
      changes: [usdcChange('mint', undefined, WALLET, '5.0000000'), usdcChange('transfer', PAYER, WALLET, '0.0010000'), usdcChange('burn', WALLET, '', '1.0000000')],
    });
    const out = transfersOf(rec);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ opId: '200', txHash: H1, from: PAYER, to: WALLET, amountUnits: 10000n, asset: USDC });
  });

  it('yields two transfers for one transaction with two balance changes, distinct idx', () => {
    const out = transfersOf(
      sorobanTransfer({ id: '300', hash: H1, changes: [usdcChange('transfer', PAYER, WALLET, '0.0009000'), usdcChange('transfer', PAYER, OWNER, '0.0001000')] }),
    );
    expect(out.map((t) => [t.idx, t.to, t.amountUnits])).toEqual([[0, WALLET, 9000n], [1, OWNER, 1000n]]);
    expect(new Set(out.map((t) => `${t.opId}:${t.idx}`)).size).toBe(2);
  });

  it('skips a failed transaction and a record without amount', () => {
    expect(transfersOf(sorobanTransfer({ id: '4', hash: H1, successful: false, changes: [usdcChange('transfer', PAYER, WALLET, '1.0000000')] }))).toEqual([]);
    expect(transfersOf({ ...classicPayment({ id: '5', hash: H1 }), transaction_successful: false })).toEqual([]);
    const noAmount = { ...classicPayment({ id: '6', hash: H1 }), amount: undefined };
    expect(transfersOf(noAmount)).toEqual([]);
    const partial = sorobanTransfer({ id: '7', hash: H1, changes: [{ type: 'transfer', to: WALLET, amount: '1.0000000', asset_type: 'native' }, usdcChange('transfer', PAYER, WALLET, '2.0000000')] });
    const out = transfersOf(partial);
    expect(out).toHaveLength(1);
    expect(out[0]!.idx).toBe(1);
  });

  it('keeps an unknown asset under its own CODE:ISSUER and skips non-payment operations', () => {
    const fake = classicPayment({ id: '8', hash: H1, asset: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: LOOKALIKE_ISSUER } });
    expect(transfersOf(fake)[0]!.asset).toBe(`USDC:${LOOKALIKE_ISSUER}`);
    expect(transfersOf({ id: '9', type: 'create_account', created_at: '2026-10-12T10:00:00Z', transaction_hash: H1, transaction_successful: true })).toEqual([]);
  });

  it('drops a zero-amount transfer (the payments table rejects amount_units <= 0)', () => {
    expect(transfersOf(classicPayment({ id: '11', hash: H1, amount: '0.0000000' }))).toEqual([]);
    const rec = sorobanTransfer({ id: '12', hash: H1, changes: [usdcChange('transfer', PAYER, WALLET, '0.0000000'), usdcChange('transfer', PAYER, WALLET, '0.0010000')] });
    expect(transfersOf(rec).map((t) => [t.idx, t.amountUnits])).toEqual([[1, 10000n]]);
  });

  it('takes hash and time from the joined transaction when the flat fields are absent', () => {
    const rec = { ...classicPayment({ id: '10', hash: H1 }), transaction_hash: undefined, created_at: undefined, transaction: { hash: H2, successful: true, created_at: '2026-10-12T11:00:00Z' } };
    expect(transfersOf(rec)[0]).toMatchObject({ txHash: H2, at: '2026-10-12T11:00:00Z' });
  });
});

describe('createHorizonReader', () => {
  it('requests the account payments page with the pinned query', async () => {
    const { r, urls } = reader([jsonResponse(horizonPage([]))]);
    await r.accountPayments(WALLET, 'abc', 50);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe(`/accounts/${WALLET}/payments`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ order: 'asc', limit: '50', include_failed: 'false', cursor: 'abc' });
  });

  it('treats 404 as an empty finished page', async () => {
    const { r, urls } = reader([jsonResponse({ status: 404, title: 'Resource Missing' }, 404)]);
    expect(await r.accountPayments(WALLET, 'c1', 200)).toEqual({ transfers: [], cursor: 'c1', done: true });
    expect(urls).toHaveLength(1);
  });

  // Observed live on testnet 2026-10-12: agents 36-38 are bound to contract (C...) addresses, and Horizon answers
  // GET /accounts/C.../payments with HTTP 400. A contract account has no Horizon payments feed.
  it('does not call Horizon for a contract (C...) address and reports an empty finished page', async () => {
    const C = 'CA4MTXFA3HCBILMODOE2JQ7KTOIUED37A4FBHEGMU6YHHOKDDC4HLQXN';
    const { r, urls } = reader([jsonResponse({ status: 400, title: 'Bad Request' }, 400)]);
    expect(await r.accountPayments(C, 'c1', 200)).toEqual({ transfers: [], cursor: 'c1', done: true });
    expect(urls).toHaveLength(0);
  });

  it('retries a 429 then succeeds, and gives up after 5 tries', async () => {
    const ok = reader([jsonResponse({ status: 429 }, 429), jsonResponse({ status: 503 }, 503), new TypeError('fetch failed'), jsonResponse(horizonPage([classicPayment({ id: '1', hash: H1 })]))]);
    expect((await ok.r.accountPayments(WALLET, null, 10)).transfers).toHaveLength(1);
    expect(ok.urls).toHaveLength(4);

    const bad = reader([jsonResponse({ status: 429 }, 429)]);
    await expect(bad.r.accountPayments(WALLET, null, 10)).rejects.toThrow('429');
    expect(bad.urls).toHaveLength(5);
  });

  it('never retries a 400', async () => {
    const { r, urls } = reader([jsonResponse({ status: 400 }, 400)]);
    await expect(r.accountPayments(WALLET, 'bad', 10)).rejects.toThrow('400');
    expect(urls).toHaveLength(1);
  });

  it('advances the cursor to the last paging_token and reports done only on a short page', async () => {
    const recs = [
      classicPayment({ id: '1', hash: H1, token: 'tok-1' }),
      { id: '2', paging_token: 'tok-2', type: 'create_account', created_at: '2026-10-12T10:00:00Z' }, // yields nothing but still moves the cursor
    ];
    const full = reader([jsonResponse(horizonPage(recs))]);
    const p1 = await full.r.accountPayments(WALLET, null, 2);
    expect(p1).toMatchObject({ cursor: 'tok-2', done: false });
    expect(p1.transfers).toHaveLength(1);

    const short = reader([jsonResponse(horizonPage(recs))]);
    expect(await short.r.accountPayments(WALLET, 'tok-0', 3)).toMatchObject({ cursor: 'tok-2', done: true });

    const empty = reader([jsonResponse(horizonPage([]))]);
    expect(await empty.r.accountPayments(WALLET, 'tok-9', 3)).toEqual({ transfers: [], cursor: 'tok-9', done: true });
  });

  it('throws on a non-empty page whose last record has no paging_token', async () => {
    const recs = [{ ...classicPayment({ id: '1', hash: H1 }), paging_token: undefined }];
    const { r } = reader([jsonResponse(horizonPage(recs))]);
    await expect(r.accountPayments(WALLET, 'c', 5)).rejects.toThrow('paging_token');
  });

  it('waits on the limiter before every attempt', async () => {
    let calls = 0;
    const q = queueFetch([jsonResponse({}, 429), jsonResponse(horizonPage([]))]);
    const r = createHorizonReader({ horizonUrl: 'https://h', fetch: q.fetch, limiter: async () => void calls++, retry: { sleep: noSleep } });
    await r.accountPayments(WALLET, null, 5);
    expect(calls).toBe(2);
  });
});

describe('createRateLimiter', () => {
  it('spaces calls 1000/rps ms apart', async () => {
    let t = 10_000;
    const sleeps: number[] = [];
    const limit = createRateLimiter(4, () => t, async (ms) => void (sleeps.push(ms), (t += ms)));
    await limit();
    await limit();
    await limit();
    expect(sleeps).toEqual([250, 250]);
    t += 5000;
    await limit();
    expect(sleeps).toEqual([250, 250]);
  });
});
