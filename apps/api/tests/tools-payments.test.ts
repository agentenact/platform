import { describe, expect, it } from 'bun:test';
import { StellarPaymentsArgs } from '../src/tools/schemas.js';
import { createPayments } from '../src/tools/payments.js';
import { STELLAR_READ } from '../src/tools/networks.js';
import { parseSpec } from '../src/specs/schema.js';
import { fakeSafeFetch } from './support/safe-fetch.js';

const ME = 'GDO73LCGQTKWCEKQ55C5BUBOFKGCAXXOP6MZ35YQ6BRSQKCKDDSAWECM';
const PAYER = 'GCH36APKUXHZV7XIYRNACW353E6AWT5TTCEEOHRSWHMS2BM74DVNKNZ3';
const CHANNEL = 'GB3V7NI54UJNSOOSGFOKNTIUTZ5GKDOGNBPRYM55GTKERAK7SIVJDSJW';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = `USDC:${USDC_ISSUER}`;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString().replace('.000Z', 'Z');

// Shapes copied from testnet Horizon (read-only GETs of the demo agent's payments, 2026-10-12). Optional fields are absent as on the wire.
const classic = (id: string, at: string, o: { from: string; to: string; amount: string; asset?: { code: string; issuer: string } | 'native'; type?: string; source?: { asset: { code: string; issuer: string } | 'native'; amount: string } }) => ({
  id,
  paging_token: id,
  transaction_successful: true,
  source_account: o.from,
  type: o.type ?? 'payment',
  type_i: 1,
  created_at: at,
  transaction_hash: 'a'.repeat(63) + id.slice(-1),
  ...(o.asset === 'native' || o.asset === undefined ? { asset_type: 'native' } : { asset_type: 'credit_alphanum4', asset_code: o.asset.code, asset_issuer: o.asset.issuer }),
  from: o.from,
  to: o.to,
  amount: o.amount,
  // Real Horizon path payments also carry what the sender spent.
  ...(o.source
    ? {
        source_amount: o.source.amount,
        ...(o.source.asset === 'native' ? { source_asset_type: 'native' } : { source_asset_type: 'credit_alphanum4', source_asset_code: o.source.asset.code, source_asset_issuer: o.source.asset.issuer }),
      }
    : {}),
});
const change = (o: { from?: string; to?: string; amount?: string; type?: string; code?: string; issuer?: string }) => ({
  asset_type: 'credit_alphanum4',
  asset_code: o.code ?? 'USDC',
  asset_issuer: o.issuer ?? USDC_ISSUER,
  type: o.type ?? 'transfer',
  ...(o.from ? { from: o.from } : {}),
  ...(o.to ? { to: o.to } : {}),
  ...(o.amount ? { amount: o.amount } : {}),
});
const soroban = (id: string, at: string, changes: unknown[]) => ({
  id,
  paging_token: id,
  transaction_successful: true,
  source_account: CHANNEL,
  type: 'invoke_host_function',
  type_i: 24,
  created_at: at,
  transaction_hash: '61f7c958a9efa06bc4c671fb59e6a173ae268a7f454afd56608062ce48fc2bff',
  function: 'HostFunctionTypeHostFunctionTypeInvokeContract',
  address: '',
  salt: '',
  asset_balance_changes: changes,
});

const feed = (records: unknown[], status = 200) =>
  fakeSafeFetch((url) => (url.includes('/payments') ? { status, body: status === 200 ? { _embedded: { records } } : { detail: 'boom' } } : undefined));
const reads = (sf: ReturnType<typeof feed>) => createPayments({ safeFetch: sf, now: () => NOW });
const args = (a: Record<string, unknown> = {}) => StellarPaymentsArgs.parse({ account: ME, ...a });

describe('stellar_payments', () => {
  it('reads classic payments newest first, native as XLM and credit as CODE:ISSUER', async () => {
    const sf = feed([
      classic('300', ago(60), { from: PAYER, to: ME, amount: '12.5000000' }),
      classic('200', ago(120), { from: ME, to: PAYER, amount: '3.0000000', asset: { code: 'USDC', issuer: USDC_ISSUER }, type: 'path_payment_strict_send', source: { asset: 'native', amount: '30.0000000' } }),
      classic('100', ago(180), { from: PAYER, to: ME, amount: '1.0000000', asset: { code: 'USDC', issuer: USDC_ISSUER }, type: 'path_payment_strict_receive', source: { asset: 'native', amount: '9.0000000' } }),
    ]);
    const r = await reads(sf).stellarPayments(args());
    expect(r).toMatchObject({ account: ME, network: 'testnet', truncated: false });
    expect(r.payments.map((p) => [p.id, p.direction, p.kind, p.asset, p.amount])).toEqual([
      ['300', 'in', 'payment', 'XLM', '12.5000000'],
      ['200', 'out', 'payment', 'XLM', '30.0000000'],
      ['100', 'in', 'payment', USDC, '1.0000000'],
    ]);
    expect(r.payments[0]).toMatchObject({ at: ago(60), from: PAYER, to: ME, tx: 'a'.repeat(63) + '0' });
    expect(sf.calls[0]!.url).toBe(`${STELLAR_READ.testnet.horizonUrl}/accounts/${ME}/payments?order=desc&limit=50&include_failed=false`);
  });

  it('reads an invoke_host_function transfer from asset_balance_changes and labels it contract_transfer', async () => {
    const r = await reads(feed([soroban('20692280553799681', ago(30), [change({ from: PAYER, to: ME, amount: '0.0010000' })])])).stellarPayments(args());
    expect(r.payments).toEqual([
      { id: '20692280553799681:0', at: ago(30), direction: 'in', kind: 'contract_transfer', from: PAYER, to: ME, asset: USDC, amount: '0.0010000', tx: '61f7c958a9efa06bc4c671fb59e6a173ae268a7f454afd56608062ce48fc2bff' },
    ]);
  });

  it('one payment per change; a transfer between two other accounts is not ours', async () => {
    const r = await reads(
      feed([soroban('9', ago(30), [change({ from: PAYER, to: ME, amount: '1.0000000' }), change({ from: PAYER, to: CHANNEL, amount: '2.0000000' }), change({ from: ME, to: PAYER, amount: '3.0000000' })])]),
    ).stellarPayments(args());
    expect(r.payments.map((p) => [p.id, p.direction, p.amount])).toEqual([
      ['9:0', 'in', '1.0000000'],
      ['9:2', 'out', '3.0000000'],
    ]);
  });

  it('ignores mint, burn and clawback changes, and other operation types', async () => {
    const r = await reads(
      feed([
        soroban('1', ago(30), [change({ type: 'mint', to: ME, amount: '5.0000000' }), change({ type: 'burn', from: ME, amount: '5.0000000' }), change({ type: 'clawback', from: ME, amount: '5.0000000' })]),
        soroban('2', ago(30), [{ asset_type: 'native', type: 'transfer', from: PAYER, to: ME, amount: '4.0000000' }]),
        { ...classic('3', ago(30), { from: PAYER, to: ME, amount: '1.0000000' }), type: 'create_account' },
        soroban('4', ago(30), []),
        { ...soroban('5', ago(30), []), asset_balance_changes: undefined },
      ]),
    ).stellarPayments(args());
    expect(r.payments.map((p) => [p.id, p.asset])).toEqual([['2:0', 'XLM']]);
  });

  it('filters by asset, min_amount (decimal-safe: "1000.0000001" > "1000"), direction and since_s, and sets truncated when more than limit match', async () => {
    const records = [
      classic('7', ago(100), { from: PAYER, to: ME, amount: '1000.0000001' }),
      classic('6', ago(200), { from: PAYER, to: ME, amount: '1000.0000000' }),
      classic('5', ago(300), { from: ME, to: PAYER, amount: '2000.0000000' }),
      classic('4', ago(400), { from: PAYER, to: ME, amount: '5000.0000000', asset: { code: 'USDC', issuer: USDC_ISSUER } }),
      classic('3', ago(4000), { from: PAYER, to: ME, amount: '9000.0000000' }),
    ];
    const ids = async (a: Record<string, unknown>) => (await reads(feed(records)).stellarPayments(args(a))).payments.map((p) => p.id);
    expect(await ids({ asset: 'XLM', min_amount: '1000.0000001' })).toEqual(['7', '5']);
    expect(await ids({ asset: 'XLM', min_amount: '1000' })).toEqual(['7', '6', '5']); // min is inclusive
    expect(await ids({ min_amount: '1000.0000001' })).toEqual(['7', '5', '4']);
    expect(await ids({ asset: USDC })).toEqual(['4']);
    expect(await ids({ direction: 'out' })).toEqual(['5']);
    expect(await ids({ direction: 'in' })).toEqual(['7', '6', '4']);
    expect(await ids({})).toEqual(['7', '6', '5', '4']); // 3 is older than since_s 3600
    expect(await ids({ since_s: 86_400 })).toEqual(['7', '6', '5', '4', '3']);
    const cut = await reads(feed(records)).stellarPayments(args({ limit: 2 }));
    expect(cut.payments.map((p) => p.id)).toEqual(['7', '6']);
    expect(cut.truncated).toBe(true);
    expect((await reads(feed(records)).stellarPayments(args({ limit: 4 }))).truncated).toBe(false);
  });

  it('an outgoing path payment reports what left the account (source asset and amount), an incoming one what arrived', async () => {
    const usdc = { code: 'USDC', issuer: USDC_ISSUER };
    const send = classic('11', ago(10), { from: ME, to: PAYER, amount: '2.0000000', asset: usdc, type: 'path_payment_strict_send', source: { asset: 'native', amount: '2000.0000000' } });
    const recv = classic('12', ago(20), { from: ME, to: PAYER, amount: '5.0000000', asset: usdc, type: 'path_payment_strict_receive', source: { asset: 'native', amount: '4.9000000' } });
    const inn = classic('13', ago(30), { from: PAYER, to: ME, amount: '7.0000000', asset: usdc, type: 'path_payment_strict_send', source: { asset: 'native', amount: '700.0000000' } });
    const r = await reads(feed([send, recv, inn])).stellarPayments(args());
    expect(r.payments.map((p) => [p.id, p.direction, p.asset, p.amount])).toEqual([
      ['11', 'out', 'XLM', '2000.0000000'],
      ['12', 'out', 'XLM', '4.9000000'],
      ['13', 'in', USDC, '7.0000000'],
    ]);
    // Watches follow the spent side: an XLM outflow watch sees the first two, a USDC outflow watch sees none.
    expect((await reads(feed([send, recv, inn])).stellarPayments(args({ asset: 'XLM', direction: 'out', min_amount: '1000' }))).payments.map((p) => p.id)).toEqual(['11']);
    expect((await reads(feed([send, recv, inn])).stellarPayments(args({ asset: USDC, direction: 'out' }))).payments).toEqual([]);
  });

  it('sets truncated when the 50-record page is exhausted inside the window', async () => {
    const full = Array.from({ length: 50 }, (_, i) => classic(String(1000 - i), ago(60 + i), { from: PAYER, to: CHANNEL, amount: '1.0000000' }));
    const r = await reads(feed(full)).stellarPayments(args({ asset: USDC })); // nothing matches, but record 51+ might
    expect(r.payments).toEqual([]);
    expect(r.truncated).toBe(true);
    // The page reached back past since_s (oldest is outside the window): nothing hidden.
    const reached = [...full.slice(0, 49), classic('1', ago(4000), { from: PAYER, to: CHANNEL, amount: '1.0000000' })];
    expect((await reads(feed(reached)).stellarPayments(args({ asset: USDC }))).truncated).toBe(false);
    // A short page is the whole history.
    expect((await reads(feed(full.slice(0, 49))).stellarPayments(args({ asset: USDC }))).truncated).toBe(false);
  });

  it('compares amounts as 7-place bigints, never Number (2^53 + 1 stroop)', async () => {
    const big = classic('1', ago(10), { from: PAYER, to: ME, amount: '900719925.4740993' });
    const at = async (min: string) => (await reads(feed([big])).stellarPayments(args({ min_amount: min }))).payments.length;
    expect(await at('900719925.4740993')).toBe(1);
    expect(await at('900719925.4740994')).toBe(0);
  });

  it('an unknown account (404) returns an empty list, not an error', async () => {
    const sf = fakeSafeFetch(() => undefined);
    expect(await reads(sf).stellarPayments(args())).toEqual({ account: ME, network: 'testnet', payments: [], truncated: false });
  });

  it('a bad account is bad_args; Horizon 500 and a non-JSON body are horizon_failed', async () => {
    const sf = feed([]);
    await expect(reads(sf).stellarPayments({ ...args(), account: 'GNOPE' })).rejects.toMatchObject({ code: 'bad_args' });
    expect(StellarPaymentsArgs.safeParse({ account: 'GNOPE' }).success).toBe(false);
    expect(sf.calls).toHaveLength(0);
    await expect(reads(feed([], 500)).stellarPayments(args())).rejects.toMatchObject({ code: 'horizon_failed' });
    await expect(reads(fakeSafeFetch(() => ({ body: '<html>' }))).stellarPayments(args())).rejects.toMatchObject({ code: 'horizon_failed' });
  });

  it('mainnet uses horizon.stellar.org; testnet is the default', async () => {
    const sf = feed([]);
    const r = await reads(sf).stellarPayments(args({ network: 'mainnet' }));
    expect(r.network).toBe('mainnet');
    expect(sf.calls[0]!.url.startsWith('https://horizon.stellar.org/accounts/')).toBe(true);
    expect(args().network).toBe('testnet');
  });

  it('the argument schema pins its bounds', () => {
    expect(args()).toMatchObject({ direction: 'both', since_s: 3600, limit: 10, network: 'testnet' });
    for (const bad of [{ since_s: 299 }, { since_s: 86_401 }, { limit: 0 }, { limit: 21 }, { min_amount: '1.12345678' }, { min_amount: '-1' }, { asset: 'USDC' }, { asset: 'USDC:GNOPE' }, { direction: 'x' }, { extra: 1 }]) {
      expect(StellarPaymentsArgs.safeParse({ account: ME, ...bad }).success).toBe(false);
    }
    expect(StellarPaymentsArgs.safeParse({ account: ME, asset: USDC, min_amount: '1000.0000001', direction: 'in' }).success).toBe(true);
  });

  it('a condition on stellar_payments parses in a spec; a bad one is refused', () => {
    const base = { persona: 'A careful analyst.', system_prompt: 'Report payments.', tools: ['stellar_payments'] };
    const trig = (a: unknown) => ({ kind: 'condition', fetch: { tool: 'stellar_payments', args: a }, code: 'return input.payments.length > 0', every_s: 300, cooldown_s: 300, mission: 'A payment arrived.' });
    expect(parseSpec({ ...base, triggers: [trig({ account: ME, direction: 'in', since_s: 300 })] }).ok).toBe(true);
    const bad = parseSpec({ ...base, triggers: [trig({ account: 'nope' })] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(JSON.stringify(bad)).toContain('not valid stellar_payments arguments');
  });
});
