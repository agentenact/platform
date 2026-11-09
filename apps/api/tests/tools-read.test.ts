import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair, nativeToScVal, scValToNative, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { TESTNET } from '../src/owner-client/testnet.js';
import { STELLAR_READ } from '../src/tools/networks.js';
import { StellarPriceChangeArgs, StellarPriceArgs, StellarReadArgs } from '../src/tools/schemas.js';
import { createChainReads, REFLECTOR_TESTNET, scaled, STALE_PRICE_SECONDS } from '../src/tools/chain.js';
import { createMarket } from '../src/tools/market.js';
import { _resetPoolForTests, shutdownPool } from '../src/tools/isolate.js';

import { createWeb, READ_MAX_CHARS } from '../src/tools/web.js';
import { egressError } from '../src/tools/safe-fetch.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

beforeAll(() => _resetPoolForTests());

const priceData = (price: bigint, ts: bigint) =>
  xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('price'), val: nativeToScVal(price, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('timestamp'), val: nativeToScVal(ts, { type: 'u64' }) }),
  ]).toXDR('base64');
const rpcResult = (retval: string) => ({ jsonrpc: '2.0', id: 1, result: { transactionData: '', minResourceFee: '90000', latestLedger: 5036546, results: [{ auth: [], xdr: retval }] } });

describe('web', () => {
  it('reads an article with Readability, and plain text as is, clipped', async () => {
    const html = `<html><head><title>XLM news</title></head><body><nav>menu menu</nav><article><h1>XLM news</h1><p>${'Stellar moved today. '.repeat(40)}</p></article><script>steal()</script></body></html>`;
    const sf = fakeSafeFetch((url) =>
      url.endsWith('/a') ? { body: html, contentType: 'text/html; charset=utf-8' } : url.endsWith('/t') ? { body: 'x '.repeat(30_000), contentType: 'text/plain' } : url.endsWith('/pdf') ? { body: '%PDF', contentType: 'application/pdf' } : undefined,
    );
    const web = createWeb({ safeFetch: sf, tavilyKey: 'k' });
    const a = await web.read('https://news.example.com/a');
    expect(a.title).toBe('XLM news');
    expect(a.text).toContain('Stellar moved today.');
    expect(a.text).not.toContain('steal()');
    expect((await web.read('https://news.example.com/t')).text.length).toBe(READ_MAX_CHARS);
    await expect(web.read('https://news.example.com/pdf')).rejects.toMatchObject({ code: 'unsupported_content' });
    await expect(web.read('https://news.example.com/missing')).rejects.toMatchObject({ code: 'read_failed' });
  });
});

describe('web.read isolation', () => {
  afterAll(() => shutdownPool());

  it('caps the title at 300 chars (a 200K-char title, inside the 256 KB extract cap)', async () => {
    const html = `<html><head><title>${'T'.repeat(200_000)}</title></head><body><article><p>${'Body text here. '.repeat(40)}</p></article></body></html>`;
    const web = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: html, contentType: 'text/html' })), tavilyKey: 'k' });
    const r = await web.read('https://x.example.com/');
    expect(r.title.length).toBeLessThanOrEqual(300);
    expect(r.text).toContain('Body text here.');
  }, 30_000);

  it('a title of control characters still parses; the page is not read_failed', async () => {
    const html = `<html><head><title>${'\u0001\u0002\u001f'.repeat(60_000)}</title></head><body><article><p>${'Body text here. '.repeat(40)}</p></article></body></html>`;
    const web = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: html, contentType: 'text/html' })), tavilyKey: 'k' });
    const r = await web.read('https://x.example.com/');
    expect(r.title.length).toBeLessThanOrEqual(300);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(r.title)).toBe(false);
    expect(r.text).toContain('Body text here.');
  }, 30_000);

  it('passes its abort signal to the pool: an aborted read does not hang', async () => {
    const ac = new AbortController();
    ac.abort();
    const web = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: '<p>x</p>', contentType: 'text/html' })), tavilyKey: 'k' });
    await expect(web.read('https://x.example.com/', ac.signal)).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('survives hostile deeply nested HTML: fixed error in time, event loop stays live', async () => {
    const sf = fakeSafeFetch(() => ({ body: '<div>'.repeat(300_000), contentType: 'text/html' }));
    const web = createWeb({ safeFetch: sf, tavilyKey: 'k' });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 20);
    const t = Date.now();
    const err = await web.read('https://evil.example.com/').then(
      () => undefined,
      (e: unknown) => e as { code?: string; message: string },
    );
    const took = Date.now() - t;
    clearInterval(iv);
    expect(err?.code).toBe('read_failed');
    expect(took).toBeLessThan(15_000);
    expect(ticks).toBeGreaterThan(took / 20 / 4);
  }, 30_000);

  it('maps empty HTML to read_failed', async () => {
    for (const body of ['', '   ']) {
      const web = createWeb({ safeFetch: fakeSafeFetch(() => ({ body, contentType: 'text/html' })), tavilyKey: 'k' });
      await expect(web.read('https://x.example.com/')).rejects.toMatchObject({ code: 'read_failed' });
    }
  });

  it('clamps the search count to 1..10', async () => {
    const sf = fakeSafeFetch(() => ({ body: { results: [] } }));
    const web = createWeb({ safeFetch: sf, tavilyKey: 'k' });
    await web.search('a', 500, undefined, () => true);
    await web.search('a', 0, undefined, () => true);
    await web.search('a', Number.NaN, undefined, () => true);
    expect(sf.calls.map((c) => JSON.parse(c.o.body as string).max_results)).toEqual([10, 1, 5]);
  });
});

describe('stellar', () => {
  it('scales Reflector integers', () => {
    expect(scaled(22191774310106n, 14)).toBe('0.22191774');
    expect(scaled(8586998676163711533n, 14)).toBe('85869.98676163');
    expect(scaled(100000000000000n, 14)).toBe('1');
  });

  it('prices XLM from Reflector (testnet CEX feed) plus the testnet SDEX book', async () => {
    const sf = fakeSafeFetch((url, o) => {
      if (url === TESTNET.rpcUrl) {
        const tx = JSON.parse(String(o.body)) as { method: string };
        expect(tx.method).toBe('simulateTransaction');
        return { body: rpcResult(priceData(22191774310106n, 1791206100n)) };
      }
      if (url.startsWith(`${TESTNET.horizonUrl}/order_book?`)) return { body: { bids: [{ price: '0.1251363', amount: '0.5' }], asks: [{ price: '0.1263940', amount: '4' }], base: { asset_type: 'native' } } };
      return undefined;
    });
    const chain = createChainReads({ safeFetch: sf, now: () => 1791206160_000 });
    expect(await chain.stellarPrice({ symbol: 'xlm' })).toEqual({
      symbol: 'XLM',
      usd: '0.22191774',
      at: new Date(1791206100_000).toISOString(),
      ageSeconds: 60,
      network: 'testnet',
      source: 'reflector-testnet',
      sdex: { pair: 'XLM/USDC (testnet SDEX)', bid: '0.1251363', ask: '0.1263940' },
    });
    expect(sf.calls[0]!.o.method).toBe('POST');
    expect(String(sf.calls[0]!.o.body)).toContain('"simulateTransaction"');
    expect(REFLECTOR_TESTNET).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('prices BTC without the SDEX book, and refuses unknown symbols and missing prices', async () => {
    const sf = fakeSafeFetch((url) => (url === TESTNET.rpcUrl ? { body: rpcResult(priceData(8586998676163711533n, 1791206100n)) } : undefined));
    const chain = createChainReads({ safeFetch: sf, now: () => 1791206100_000 });
    expect(await chain.stellarPrice({ symbol: 'BTC' })).toMatchObject({ symbol: 'BTC', usd: '85869.98676163', ageSeconds: 0 });
    expect(sf.calls.length).toBe(1);
    await expect(chain.stellarPrice({ symbol: 'DOGE' })).rejects.toMatchObject({ code: 'unknown_symbol' });
    const none = createChainReads({ safeFetch: fakeSafeFetch(() => ({ body: rpcResult(xdr.ScVal.scvVoid().toXDR('base64')) })) });
    await expect(none.stellarPrice({ symbol: 'ETH' })).rejects.toMatchObject({ code: 'no_price' });
    const broken = createChainReads({ safeFetch: fakeSafeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, result: { error: 'HostError: …', latestLedger: 1 } } })) });
    await expect(broken.stellarPrice({ symbol: 'ETH' })).rejects.toMatchObject({ code: 'rpc_failed' });
  });

  it('reads an account and a transaction from Horizon, and reports absence', async () => {
    const id = Keypair.random().publicKey();
    const hash = 'a'.repeat(64);
    const sf = fakeSafeFetch((url) => {
      if (url === `${TESTNET.horizonUrl}/accounts/${id}`)
        return { body: { id, sequence: '123', balances: [{ balance: '9.9000000', asset_type: 'native' }, { balance: '0.0100000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }] } };
      if (url === `${TESTNET.horizonUrl}/transactions/${hash}`) return { body: { hash, successful: true, created_at: '2026-10-05T10:00:00Z', operation_count: 1, memo_type: 'none', fee_charged: '100' } };
      return undefined;
    });
    const chain = createChainReads({ safeFetch: sf });
    expect(await chain.stellarRead({ kind: 'account', id })).toEqual({
      exists: true,
      id,
      sequence: '123',
      balances: [{ asset: 'XLM', balance: '9.9000000' }, { asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', balance: '0.0100000' }],
    });
    expect(await chain.stellarRead({ kind: 'transaction', hash })).toEqual({ exists: true, hash, successful: true, createdAt: '2026-10-05T10:00:00Z', operationCount: 1, memo: null, feeCharged: '100' });
    expect(await chain.stellarRead({ kind: 'transaction', hash: 'b'.repeat(64) })).toEqual({ exists: false });
    await expect(chain.stellarRead({ kind: 'account', id: 'GNOPE' })).rejects.toMatchObject({ code: 'bad_args' });
  });
});

describe('market', () => {
  it('prices from DefiLlama when it has every id', async () => {
    const sf = fakeSafeFetch((url) =>
      url.startsWith('https://coins.llama.fi/') ? { body: { coins: { 'coingecko:stellar': { price: 0.2217, symbol: 'XLM', timestamp: 1791205310, confidence: 0.99 }, 'coingecko:bitcoin': { price: 85963.6, symbol: 'BTC', timestamp: 1791205310, confidence: 0.99 } } } } : undefined,
    );
    expect(await createMarket({ safeFetch: sf }).marketPrice({ ids: ['stellar', 'bitcoin'] })).toEqual({ prices: { stellar: 0.2217, bitcoin: 85963.6 }, source: 'defillama' });
    expect(sf.calls[0]!.url).toBe('https://coins.llama.fi/prices/current/coingecko:stellar,coingecko:bitcoin');
  });

  it('falls back to CoinGecko for missing ids, and for a DefiLlama outage', async () => {
    const partial = fakeSafeFetch((url) =>
      url.startsWith('https://coins.llama.fi/') ? { body: { coins: { 'coingecko:stellar': { price: 0.2217 } } } } : url.startsWith('https://api.coingecko.com/') ? { body: { bitcoin: { usd: 85964 } } } : undefined,
    );
    expect(await createMarket({ safeFetch: partial }).marketPrice({ ids: ['stellar', 'bitcoin', 'nope'] })).toEqual({ prices: { stellar: 0.2217, bitcoin: 85964, nope: null }, source: 'mixed' });
    expect(new URL(partial.calls[1]!.url).searchParams.get('ids')).toBe('bitcoin,nope');
    const down = fakeSafeFetch((url) => (url.startsWith('https://coins.llama.fi/') ? { status: 502, body: 'bad gateway' } : { body: { stellar: { usd: 0.2218 } } }));
    expect(await createMarket({ safeFetch: down }).marketPrice({ ids: ['stellar'] })).toEqual({ prices: { stellar: 0.2218 }, source: 'coingecko' });
  });

  it('refuses bad ids', async () => {
    await expect(createMarket({ safeFetch: fakeSafeFetch(() => undefined) }).marketPrice({ ids: ['Bad Id'] })).rejects.toMatchObject({ code: 'bad_args' });
  });
});

describe('realistic upstream shapes', () => {
  it('survives Tavily answers with optional fields absent', async () => {
    const none = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: { query: 'q' } })), tavilyKey: 'k' });
    expect(await none.search('q', undefined, undefined, () => true)).toEqual({ results: [] });
    const sparse = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: { results: [{ url: 'https://a.example/' }] } })), tavilyKey: 'k' });
    expect(await sparse.search('q', undefined, undefined, () => true)).toEqual({ results: [{ title: '', url: 'https://a.example/', description: '' }] });
    const junk = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: '<html>oops</html>', contentType: 'text/html' })), tavilyKey: 'k' });
    await expect(junk.search('q', undefined, undefined, () => true)).rejects.toMatchObject({ code: 'search_failed' });
  });

  it('maps a response with no content type to unsupported_content', async () => {
    const web = createWeb({ safeFetch: fakeSafeFetch(() => ({ body: 'hi', contentType: '' })), tavilyKey: 'k' });
    await expect(web.read('https://x.example.com/')).rejects.toMatchObject({ code: 'unsupported_content' });
  });

  it('reports Horizon and RPC outages as fixed codes', async () => {
    const chain = createChainReads({ safeFetch: fakeSafeFetch(() => ({ status: 503, body: 'down' })) });
    await expect(chain.stellarRead({ kind: 'transaction', hash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'horizon_failed' });
    await expect(chain.stellarPrice({ symbol: 'BTC' })).rejects.toMatchObject({ code: 'rpc_failed' });
    await expect(chain.stellarRead({ kind: 'transaction', hash: 'XYZ' })).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('prices XLM with an empty SDEX book as null sides', async () => {
    const rpc = (url: string) => (url === TESTNET.rpcUrl ? { body: rpcResult(priceData(22191774310106n, 1791206100n)) } : undefined);
    const empty = createChainReads({ safeFetch: fakeSafeFetch((u) => rpc(u) ?? { body: { bids: [], asks: [] } }) });
    expect((await empty.stellarPrice({ symbol: 'XLM' })).sdex).toEqual({ pair: 'XLM/USDC (testnet SDEX)', bid: null, ask: null });
  });

  it('fails market_price when no source has any price, and ignores non-numeric prices', async () => {
    const dead = fakeSafeFetch(() => ({ status: 429, body: 'slow down' }));
    await expect(createMarket({ safeFetch: dead }).marketPrice({ ids: ['stellar'] })).rejects.toMatchObject({ code: 'price_unavailable' });
    const odd = fakeSafeFetch((u) => (u.startsWith('https://coins.llama.fi/') ? { body: { coins: { 'coingecko:stellar': { price: 'NaN' } } } } : { body: { stellar: { usd: 0.22 } } }));
    expect(await createMarket({ safeFetch: odd }).marketPrice({ ids: ['stellar'] })).toEqual({ prices: { stellar: 0.22 }, source: 'coingecko' });
    await expect(createMarket({ safeFetch: dead }).marketPrice({ ids: [] })).rejects.toMatchObject({ code: 'bad_args' });
  });
});

describe('hardening (review fixes)', () => {
  const rpc = (url: string) => (url === TESTNET.rpcUrl ? { body: rpcResult(priceData(22191774310106n, 1791206100n)) } : undefined);
  const mapNoPrice = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('timestamp'), val: nativeToScVal(1791206100n, { type: 'u64' }) })]).toXDR('base64');

  it('throws a fixed code for a missing, zero or negative Reflector price', async () => {
    const missing = createChainReads({ safeFetch: fakeSafeFetch(() => ({ body: rpcResult(mapNoPrice) })) });
    await expect(missing.stellarPrice({ symbol: 'ETH' })).rejects.toMatchObject({ code: 'no_price' });
    for (const p of [0n, -5n]) {
      const c = createChainReads({ safeFetch: fakeSafeFetch(() => ({ body: rpcResult(priceData(p, 1791206100n)) })) });
      await expect(c.stellarPrice({ symbol: 'ETH' })).rejects.toMatchObject({ code: 'no_price' });
    }
  });

  it('keeps the Reflector price when the SDEX book fails', async () => {
    for (const bad of [{ status: 503, body: 'down' }, { body: 'not json' }]) {
      const chain = createChainReads({ safeFetch: fakeSafeFetch((u) => rpc(u) ?? bad), now: () => 1791206160_000 });
      const out = await chain.stellarPrice({ symbol: 'XLM' });
      expect(out.usd).toBe('0.22191774');
      expect('sdex' in out).toBe(false);
    }
  });

  it('flags prices older than three Reflector resolutions', async () => {
    expect(STALE_PRICE_SECONDS).toBe(900);
    const at = (age: number) => createChainReads({ safeFetch: fakeSafeFetch(rpc), now: () => (1791206100 + age) * 1000 }).stellarPrice({ symbol: 'ETH' });
    expect((await at(901)).stale).toBe(true);
    const fresh = await at(900);
    expect('stale' in fresh).toBe(false);
  });

  it('shows a pool share without an id as LP:unknown', async () => {
    const id = Keypair.random().publicKey();
    const sf = fakeSafeFetch(() => ({ body: { id, sequence: '1', balances: [{ balance: '2.0000000', asset_type: 'liquidity_pool_shares' }] } }));
    const out = (await createChainReads({ safeFetch: sf }).stellarRead({ kind: 'account', id })) as { balances: { asset: string }[] };
    expect(out.balances[0]!.asset).toBe('LP:unknown');
  });

  it('renders liquidity pool shares as LP:<id> and caps balances at 50', async () => {
    const id = Keypair.random().publicKey();
    const poolId = 'a'.repeat(64);
    const many = Array.from({ length: 60 }, (_, i) => ({ balance: '1.0000000', asset_type: 'credit_alphanum4', asset_code: `T${i}`, asset_issuer: 'GISSUER' }));
    const sf = fakeSafeFetch(() => ({ body: { id, sequence: '1', balances: [{ balance: '2.0000000', asset_type: 'liquidity_pool_shares', liquidity_pool_id: poolId }, ...many] } }));
    const out = (await createChainReads({ safeFetch: sf }).stellarRead({ kind: 'account', id })) as { balances: { asset: string }[] };
    expect(out.balances[0]!.asset).toBe(`LP:${poolId}`);
    expect(out.balances.length).toBe(50);
    expect(out.balances.some((b) => b.asset.includes('undefined'))).toBe(false);
  });

  it('propagates an egress error as its fixed code', async () => {
    const chain = createChainReads({ safeFetch: async () => { throw egressError('too_large'); } });
    await expect(chain.stellarPrice({ symbol: 'BTC' })).rejects.toMatchObject({ code: 'too_large' });
    await expect(chain.stellarRead({ kind: 'transaction', hash: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('market: prototype keys are never prices, negative prices are null', async () => {
    const down = fakeSafeFetch((u) => (u.startsWith('https://coins.llama.fi/') ? { status: 502, body: 'x' } : { body: {} }));
    await expect(createMarket({ safeFetch: down }).marketPrice({ ids: ['constructor'] })).rejects.toMatchObject({ code: 'price_unavailable' });
    const mixed = fakeSafeFetch((u) => (u.startsWith('https://coins.llama.fi/') ? { body: { coins: { 'coingecko:stellar': { price: 0.2 } } } } : { body: {} }));
    const r = await createMarket({ safeFetch: mixed }).marketPrice({ ids: ['stellar', 'constructor'] });
    expect(r.prices.stellar).toBe(0.2);
    expect(r.prices.constructor).toBeNull();
    const neg = fakeSafeFetch((u) => (u.startsWith('https://coins.llama.fi/') ? { body: { coins: { 'coingecko:stellar': { price: -1 } } } } : { body: { stellar: { usd: 0.3 } } }));
    expect((await createMarket({ safeFetch: neg }).marketPrice({ ids: ['stellar'] })).prices.stellar).toBe(0.3);
  });
});

/** What a Reflector simulate request asked for: the contract, function and decoded arguments. */
function decodeCall(passphrase: string, body: unknown) {
  const { params } = JSON.parse(String(body)) as { params: { transaction: string } };
  const tx = TransactionBuilder.fromXDR(params.transaction, passphrase) as Transaction;
  const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
  const inv = op.func.invokeContract();
  return { contract: scValToNative(xdr.ScVal.scvAddress(inv.contractAddress())) as string, fn: inv.functionName().toString(), args: inv.args().map((a) => scValToNative(a) as unknown) };
}

describe('mainnet reads (read-only)', () => {
  const M = STELLAR_READ.mainnet;
  const T = STELLAR_READ.testnet;

  it('pins distinct pubnet values: pubnet USDC issuer from the library, a Reflector id that is not the testnet one', () => {
    expect(M.usdcIssuer).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
    expect(M.reflector).toMatch(/^C[A-Z2-7]{55}$/);
    expect(M.reflector).not.toBe(T.reflector);
    expect(M.passphrase).toBe('Public Global Stellar Network ; September 2015');
    expect(T.reflector).toBe(REFLECTOR_TESTNET);
  });

  it('stellarPrice on mainnet calls the pubnet RPC with the pubnet contract and reads the pubnet SDEX book with the pubnet USDC issuer', async () => {
    const sf = fakeSafeFetch((url, o) => {
      if (url === M.rpcUrl) {
        const c = decodeCall(M.passphrase, o.body);
        expect(c.contract).toBe(M.reflector);
        expect(c.fn).toBe('lastprice');
        return { body: rpcResult(priceData(19972458106822n, 1791809700n)) };
      }
      if (url.startsWith(`${M.horizonUrl}/order_book?`)) {
        expect(url).toContain(`buying_asset_issuer=${M.usdcIssuer}`);
        return { body: { bids: [{ price: '0.1990000', amount: '1' }], asks: [{ price: '0.2000000', amount: '1' }] } };
      }
      return undefined;
    });
    const out = await createChainReads({ safeFetch: sf, now: () => 1791809760_000 }).stellarPrice({ symbol: 'XLM', network: 'mainnet' });
    expect(out).toEqual({
      symbol: 'XLM',
      usd: '0.19972458',
      at: new Date(1791809700_000).toISOString(),
      ageSeconds: 60,
      network: 'mainnet',
      source: 'reflector-pubnet',
      sdex: { pair: 'XLM/USDC (mainnet SDEX)', bid: '0.1990000', ask: '0.2000000' },
    });
    expect(sf.calls.map((c) => c.url).every((u) => !u.includes('testnet'))).toBe(true);
  });

  it('stellarRead on mainnet uses the pubnet Horizon only', async () => {
    const id = Keypair.random().publicKey();
    const sf = fakeSafeFetch((url) => (url === `${M.horizonUrl}/accounts/${id}` ? { body: { id, sequence: '5', balances: [{ balance: '1.0000000', asset_type: 'native' }] } } : undefined));
    expect(await createChainReads({ safeFetch: sf }).stellarRead({ kind: 'account', id, network: 'mainnet' })).toMatchObject({ exists: true, balances: [{ asset: 'XLM' }] });
    expect(sf.calls.map((c) => c.url)).toEqual([`${M.horizonUrl}/accounts/${id}`]);
  });
});

describe('stellarPriceChange', () => {
  const NOW = 1791809760;
  const latest = 1791809700; // a multiple of 300
  /** Answers lastprice with `to` and price(asset, t) from `history`; records every price() timestamp. */
  function reflector(to: bigint, history: (t: number) => bigint | null, network: 'testnet' | 'mainnet' = 'testnet') {
    const net = STELLAR_READ[network];
    const asked: { fn: string; asset: unknown; t?: bigint }[] = [];
    const sf = fakeSafeFetch((url, o) => {
      if (url !== net.rpcUrl) return undefined;
      const c = decodeCall(net.passphrase, o.body);
      expect(c.contract).toBe(net.reflector);
      if (c.fn === 'lastprice') return { body: rpcResult(priceData(to, BigInt(latest))) };
      const t = c.args[1] as bigint;
      asked.push({ fn: c.fn, asset: c.args[0], t });
      const p = history(Number(t));
      return { body: rpcResult(p === null ? xdr.ScVal.scvVoid().toXDR('base64') : priceData(p, t)) };
    });
    return { sf, asked, chain: createChainReads({ safeFetch: sf, now: () => NOW * 1000 }) };
  }
  const P = (usd: string) => BigInt(Math.round(Number(usd) * 1e6)) * 10n ** 8n;

  it('100 then 95 over 3600 s gives changePct -5, asking price(asset, t0) with t0 on the 300 s grid', async () => {
    const r = reflector(P('95'), () => P('100'));
    const out = await r.chain.stellarPriceChange({ symbol: 'xlm', window_s: 3600 });
    const t0 = Math.floor((latest - 3600) / 300) * 300;
    expect(r.asked).toEqual([{ fn: 'price', asset: ['Other', 'XLM'], t: BigInt(t0) }]);
    expect(out).toEqual({
      symbol: 'XLM',
      network: 'testnet',
      windowSeconds: 3600,
      from: { usd: '100', at: new Date(t0 * 1000).toISOString() },
      to: { usd: '95', at: new Date(latest * 1000).toISOString() },
      changePct: -5,
    });
  });

  it('floors a window that is off the grid: t0 = floor((to - window) / 300) * 300', async () => {
    const r = reflector(P('100'), () => P('100'));
    await r.chain.stellarPriceChange({ symbol: 'BTC', window_s: 3601 });
    expect(r.asked[0]!.t).toBe(BigInt(Math.floor((latest - 3601) / 300) * 300));
  });

  it('100 -> 100.004 rounds to 0 and 100 -> 100.2 gives 0.2 (two decimals, bigint math)', async () => {
    expect((await reflector(P('100.004'), () => P('100')).chain.stellarPriceChange({ symbol: 'XLM', window_s: 300 })).changePct).toBe(0);
    expect((await reflector(P('100.2'), () => P('100')).chain.stellarPriceChange({ symbol: 'XLM', window_s: 300 })).changePct).toBe(0.2);
    expect((await reflector(P('99.996'), () => P('100')).chain.stellarPriceChange({ symbol: 'XLM', window_s: 300 })).changePct).toBe(0);
  });

  it('missing history or a missing latest price gives no_price', async () => {
    await expect(reflector(P('95'), () => null).chain.stellarPriceChange({ symbol: 'XLM', window_s: 3600 })).rejects.toMatchObject({ code: 'no_price' });
    const none = createChainReads({ safeFetch: fakeSafeFetch(() => ({ body: rpcResult(xdr.ScVal.scvVoid().toXDR('base64')) })) });
    await expect(none.stellarPriceChange({ symbol: 'XLM', window_s: 3600 })).rejects.toMatchObject({ code: 'no_price' });
  });

  it('a stale latest price is flagged stale: true', async () => {
    const r = reflector(P('95'), () => P('100'));
    const late = createChainReads({ safeFetch: r.sf, now: () => (latest + STALE_PRICE_SECONDS + 1) * 1000 });
    expect(await late.stellarPriceChange({ symbol: 'XLM', window_s: 3600 })).toMatchObject({ stale: true, changePct: -5 });
    expect('stale' in (await r.chain.stellarPriceChange({ symbol: 'XLM', window_s: 3600 }))).toBe(false);
  });

  it('on mainnet it reads the pubnet contract only', async () => {
    const r = reflector(P('90'), () => P('100'), 'mainnet');
    const out = await r.chain.stellarPriceChange({ symbol: 'XLM', window_s: 3600, network: 'mainnet' });
    expect(out).toMatchObject({ network: 'mainnet', changePct: -10 });
    expect(r.sf.calls.every((c) => c.url === STELLAR_READ.mainnet.rpcUrl)).toBe(true);
  });

  it('refuses unknown symbols and windows the schema would refuse', async () => {
    const { chain } = reflector(P('1'), () => P('1'));
    await expect(chain.stellarPriceChange({ symbol: 'DOGE', window_s: 3600 })).rejects.toMatchObject({ code: 'unknown_symbol' });
    await expect(chain.stellarPriceChange({ symbol: 'XLM', window_s: 60 })).rejects.toMatchObject({ code: 'bad_args' });
  });

  it('StellarPriceChangeArgs rejects window_s 299, 86401 and a non-integer; network defaults to testnet', () => {
    const ok = { symbol: 'XLM', window_s: 3600 } as const;
    expect(StellarPriceChangeArgs.parse(ok)).toEqual({ ...ok, network: 'testnet' });
    expect(StellarPriceChangeArgs.parse({ ...ok, window_s: 300 }).window_s).toBe(300);
    expect(StellarPriceChangeArgs.parse({ ...ok, window_s: 86_400 }).window_s).toBe(86_400);
    for (const window_s of [299, 86_401, 3600.5]) expect(StellarPriceChangeArgs.safeParse({ ...ok, window_s }).success).toBe(false);
    expect(StellarPriceChangeArgs.safeParse({ ...ok, network: 'devnet' }).success).toBe(false);
    expect(StellarPriceArgs.parse({ symbol: 'XLM' }).network).toBe('testnet');
    expect(StellarReadArgs.parse({ kind: 'transaction', hash: 'a'.repeat(64) }).network).toBe('testnet');
  });
});
