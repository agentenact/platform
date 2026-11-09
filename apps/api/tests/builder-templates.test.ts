import { describe, expect, it } from 'bun:test';
import type { AuthVerifier } from '../src/account/auth.js';
import { checkDraft, DraftResult } from '../src/builder/draft-schema.js';
import { handoffProblem } from '../src/builder/handoff.js';
import { applyParam } from '../src/builder/params.js';
import { draftScopeProblem, walletProblem } from '../src/builder/scope.js';
import { agentTemplates, TEMPLATE_ID } from '../src/builder/templates.js';
import { createApp } from '../src/gateway/app.js';
import { CHAINS, EVM_MAX_SINCE_S } from '../src/tools/wallets.js';
import type { ChainId } from '../src/tools/schemas.js';

const ORIGIN = 'https://app.agentenact.io';

describe('agent templates', () => {
  it('are unique, kebab-case ids with a title and a one-line summary', () => {
    const t = agentTemplates();
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(new Set(t.map((x) => x.id)).size).toBe(t.length);
    for (const x of t) {
      expect(x.id).toMatch(TEMPLATE_ID);
      expect(x.title.length).toBeGreaterThan(0);
      expect(x.summary.length).toBeLessThanOrEqual(120);
    }
  });
  it('each draft passes what a Builder answer passes: shape, checks, scope, handoff', () => {
    for (const { draft } of agentTemplates()) {
      expect(DraftResult.safeParse(draft).success).toBe(true);
      expect(checkDraft(draft)).toBeNull();
      expect(draftScopeProblem(draft)).toBeNull();
      expect('draft' in handoffProblem(draft)).toBe(true);
    }
    // Building and checking every draft parses each schedule; that takes seconds on a slower machine.
  }, 30_000);
  it('a fresh list each call, so an edit to one copy never reaches the next caller', () => {
    const a = agentTemplates();
    a[0]!.draft.name = 'changed';
    expect(agentTemplates()[0]!.draft.name).not.toBe('changed');
  });
});

describe('template conditions fire on the reading they are for, and stay quiet otherwise', () => {
  // The sandbox runs the code as `new Function("input", code)` with `params` as a frozen global; a plain function with
  // `params` as an argument reads the same names.
  // Built once: each agentTemplates() call builds and checks all of them.
  const all = agentTemplates();
  const run = (id: string, input: unknown) => {
    const t = all.find((x) => x.id === id)!.draft.spec.triggers[0]!;
    if (t.kind !== 'condition') throw new Error(`${id} has no condition`);
    return new Function('input', 'params', t.code)(input, Object.freeze({ ...t.params })) as boolean;
  };
  const cases: [string, unknown, unknown][] = [
    ['coin-crash', { changePct: -12.5 }, { changePct: -3 }],
    ['coin-jump', { changePct: 6.2 }, { changePct: 1 }],
    ['price-target', { usd: '1.0200000' }, { usd: '0.4100000' }],
    ['usdc-peg', { usd: '0.9810000' }, { usd: '0.9998000' }],
    ['payment-received', { payments: [{ amount: '5' }] }, { payments: [] }],
    ['btc-range', { usd: '72000.0000000' }, { usd: '80500.0000000' }],
    ['big-move', { changePct: -4.6 }, { changePct: 2.1 }],
    ['money-out', { payments: [{ amount: '5' }] }, { payments: [] }],
    ['big-usdt', { payments: [{ amount: '15000' }] }, { payments: [] }],
    ['low-usdc', { exists: true, balances: [{ symbol: 'ETH', asset: 'ETH', amount: '9' }, { symbol: 'USDC', asset: 'USDC:0xa', amount: '42.5' }] }, { exists: true, balances: [{ symbol: 'ETH', asset: 'ETH', amount: '9' }, { symbol: 'USDC', asset: 'USDC:0xa', amount: '500' }] }],
    ['daily-balance', { exists: true, balances: [{ symbol: 'XLM', asset: 'XLM', amount: '5' }] }, { exists: false, balances: [] }],
    ['stablecoin-received', { payments: [{ amount: '250' }] }, { payments: [] }],
    ['btc-received', { payments: [{ amount: '0.002' }] }, { payments: [] }],
    ['quiet-wallet', { payments: [] }, { payments: [{ amount: '5' }] }],
    ['stablecoin-peg', { prices: { tether: 0.981, dai: 1, 'ethena-usde': 0.999, 'paypal-usd': 1, 'first-digital-usd': 1 } }, { prices: { tether: 0.9995, dai: 1.001, 'ethena-usde': 0.998, 'paypal-usd': 1, 'first-digital-usd': 0.999 } }],
    ['low-balance', { exists: true, balances: [{ symbol: 'XLM', asset: 'XLM', amount: '42.5' }] }, { exists: true, balances: [{ symbol: 'XLM', asset: 'XLM', amount: '500' }] }],
  ];
  for (const [id, fires, quiet] of cases)
    it(id, () => {
      expect(run(id, fires)).toBe(true);
      expect(run(id, quiet)).toBe(false);
    });
  it('an old price or a missing wallet never fires', () => {
    expect(run('coin-crash', { changePct: -40, stale: true })).toBe(false);
    expect(run('price-target', { usd: '5', stale: true })).toBe(false);
    expect(run('usdc-peg', { usd: '0.5', stale: true })).toBe(false);
    expect(run('low-balance', { exists: false })).toBe(false);
    expect(run('btc-range', { usd: '95000', stale: true })).toBe(false);
    expect(run('big-move', { changePct: 9, stale: true })).toBe(false);
  });
  it('low-usdc fires on a wallet that holds no USDC at all (the read lists only what is held)', () => {
    expect(run('low-usdc', { exists: true, balances: [{ symbol: 'ETH', asset: 'ETH', amount: '9' }] })).toBe(true);
    expect(run('low-usdc', { exists: false, balances: [] })).toBe(false);
  });
  it('a missing price is not a lost peg', () => {
    expect(run('stablecoin-peg', { prices: { tether: null, dai: null, 'ethena-usde': 1, 'paypal-usd': null, 'first-digital-usd': null } })).toBe(false);
  });
  it('btc-range fires above the band too', () => {
    expect(run('btc-range', { usd: '91000.0000000' })).toBe(true);
    expect(run('big-move', { changePct: 4.6 })).toBe(true);
  });
});

describe('GET /api/builder/templates', () => {
  const limits = { admit: async () => { throw new Error('templates must not count a limit'); }, addTokens: async () => { throw new Error('no tokens'); } };
  const builder = { draft: async () => { throw new Error('templates must not call the model'); } };
  const verify: AuthVerifier = async () => null;
  const app = (killed = false) =>
    createApp({ sql: {} as never, verify, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN, builder: { builder, limits, killed } as never });
  const get = (killed?: boolean) => app(killed)(new Request('https://api.agentenact.io/api/builder/templates', { headers: { origin: ORIGIN } }), '203.0.113.9');

  it('answers every template with the app CORS, no model and no limit', async () => {
    const r = await get();
    expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([200, ORIGIN]);
    expect(await r.json()).toEqual({ templates: JSON.parse(JSON.stringify(agentTemplates())) });
  });
  it('still answers while the kill switch is on: nothing is spent', async () => {
    expect((await get(true)).status).toBe(200);
  });
});

describe('wallet templates that read any chain', () => {
  const ids = ['money-out', 'big-usdt', 'low-usdc', 'daily-balance'];
  const all = agentTemplates();
  const tpl = (id: string) => all.find((x) => x.id === id)!.draft;
  const fetchOf = (id: string) => {
    const t = tpl(id).spec.triggers[0]!;
    if (t.kind !== 'condition') throw new Error('no condition');
    return t;
  };
  // A real-shaped address for each chain family.
  const ADDRESS: Record<string, string> = {
    stellar: `G${'A'.repeat(55)}`,
    evm: `0x${'ab'.repeat(20)}`,
    solana: '11111111111111111111111111111112',
    bitcoin: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',
  };
  const family = (c: string) => (['stellar', 'solana', 'bitcoin'].includes(c) ? c : 'evm');

  it('are listed, read only, and email', () => {
    for (const id of ids) {
      const d = tpl(id);
      expect(d.spec.tools).toEqual(['send_email']);
      expect(['wallet_payments', 'wallet_balance']).toContain(fetchOf(id).fetch.tool);
    }
  });
  it('start consistent: the sample wallet fits the starting network', () => {
    for (const id of ids) {
      expect(draftScopeProblem(tpl(id))).toBeNull();
      expect(walletProblem(tpl(id).spec)).toBeNull();
    }
  });
  it('every network option binds, and fits once the wallet is one of that network', () => {
    for (const id of ids) {
      const chain = tpl(id).params.find((p) => p.id === 'chain');
      if (!chain || chain.kind !== 'choice') throw new Error(`${id} has no network choice`);
      for (const o of chain.options) {
        const a = applyParam(tpl(id), 'chain', o.value);
        if (!a.ok) throw new Error(`${id} ${o.value}: ${a.problem}`);
        expect((a.draft.spec.triggers[0] as unknown as { fetch: { args: { chain: string } } }).fetch.args.chain).toBe(String(o.value));
        const b = applyParam(a.draft, 'account', ADDRESS[family(String(o.value))]!);
        if (!b.ok) throw new Error(`${id} ${o.value}: ${b.problem}`);
        expect(walletProblem(b.draft.spec)).toBeNull();
        expect(draftScopeProblem(b.draft)).toBeNull();
      }
    }
  });
  it('a wallet of the wrong network is named before hand-off', () => {
    const a = applyParam(tpl('money-out'), 'chain', 'base');
    if (!a.ok) throw new Error(a.problem);
    expect(walletProblem(a.draft.spec)).toContain('Base');
  });
  it('payment reads stay inside what a chain can serve: EVM windows, no native EVM reads, USDT only where it exists', () => {
    for (const id of ['money-out', 'big-usdt']) {
      const t = fetchOf(id);
      expect(t.fetch.tool).toBe('wallet_payments');
      expect(Number(t.fetch.args.since_s)).toBeLessThanOrEqual(EVM_MAX_SINCE_S);
      expect(t.fetch.args.asset).not.toBe('native');
    }
    const usdt = tpl('big-usdt').params.find((p) => p.id === 'chain');
    if (!usdt || usdt.kind !== 'choice') throw new Error('no network choice');
    const values = usdt.options.map((o) => o.value);
    expect(values).not.toContain('stellar');
    expect(values).not.toContain('bitcoin');
    expect(fetchOf('big-usdt').fetch.args.asset).toBe('USDT');
    const usdc = tpl('low-usdc').params.find((p) => p.id === 'chain');
    if (!usdc || usdc.kind !== 'choice') throw new Error('no network choice');
    expect(usdc.options.map((o) => o.value)).not.toContain('bitcoin');
  });
  it('money-out reads only outgoing payments', () => {
    expect(fetchOf('money-out').fetch.args.direction).toBe('out');
  });
  it('daily-balance fires once a day', () => {
    const t = fetchOf('daily-balance');
    expect([t.every_s, t.cooldown_s]).toEqual([86_400, 86_400]);
  });
});

describe('more multi-chain templates: stablecoin received, Bitcoin confirmed, quiet wallet', () => {
  const all = agentTemplates();
  const tpl = (id: string) => all.find((x) => x.id === id)!.draft;
  const fetchOf = (id: string) => {
    const t = tpl(id).spec.triggers[0]!;
    if (t.kind !== 'condition') throw new Error('no condition');
    return t;
  };
  const optionsOf = (id: string) => {
    const c = tpl(id).params.find((p) => p.id === 'chain');
    if (!c || c.kind !== 'choice') throw new Error(`${id} has no network choice`);
    return c.options.map((o) => String(o.value) as ChainId);
  };
  /** A wallet each network accepts (a real 32-byte Solana key; Bitcoin mainnet and testnet prefixes). */
  const WALLET: Record<string, string> = {
    stellar: `G${'B'.repeat(55)}`,
    evm: '0x4cfc111e7aa7b1594b3699cdf48521073bd723e6',
    solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    bitcoin: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    'bitcoin-testnet4': 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  };
  const walletFor = (chain: ChainId) => WALLET[chain] ?? WALLET[CHAINS[chain].family]!;
  const ids = ['stablecoin-received', 'btc-received', 'quiet-wallet'];

  it('every network offered passes the hand-off once the wallet fits it', () => {
    for (const id of ids)
      for (const chain of optionsOf(id)) {
        const a = applyParam(tpl(id), 'account', walletFor(chain));
        if (!a.ok) throw new Error(`${id}: ${a.problem}`);
        const b = applyParam(a.draft, 'chain', chain);
        if (!b.ok) throw new Error(`${id} on ${chain}: ${b.problem}`);
        const h = handoffProblem(b.draft);
        expect([id, chain, 'problem' in h ? h.problem : null]).toEqual([id, chain, null]);
      }
  });
  it('the starting wallet fits the starting network', () => {
    for (const id of ids) expect(walletProblem(tpl(id).spec)).toBeNull();
  });
  it('stablecoin-received offers only networks that carry both USDC and USDT, inside the EVM window', () => {
    for (const chain of optionsOf('stablecoin-received')) expect([chain, Object.keys(CHAINS[chain].tokens).sort()]).toEqual([chain, ['USDC', 'USDT']]);
    for (const coin of ['USDC', 'USDT']) {
      const a = applyParam(tpl('stablecoin-received'), 'coin', coin);
      if (!a.ok) throw new Error(a.problem);
      expect((a.draft.spec.triggers[0] as unknown as { fetch: { args: { asset: string } } }).fetch.args.asset).toBe(coin);
    }
    const t = fetchOf('stablecoin-received');
    expect([t.fetch.args.direction, Number(t.fetch.args.since_s) <= EVM_MAX_SINCE_S]).toEqual(['in', true]);
  });
  it('btc-received reads confirmed Bitcoin payments in, with an hour of slack for late block times', () => {
    expect(optionsOf('btc-received')).toEqual(['bitcoin', 'bitcoin-testnet4']);
    const t = fetchOf('btc-received');
    expect([t.fetch.args.asset, t.fetch.args.direction, t.fetch.args.since_s, t.every_s, t.cooldown_s]).toEqual(['native', 'in', 3600, 600, 3600]);
  });
  it('quiet-wallet looks a whole day back, so it offers no EVM network (an hour at most there, and no native coin)', () => {
    expect(optionsOf('quiet-wallet')).toEqual(['stellar', 'solana', 'bitcoin']);
    const t = fetchOf('quiet-wallet');
    expect([t.fetch.args.direction, t.fetch.args.since_s]).toEqual(['in', 86_400]);
    const a = applyParam(tpl('quiet-wallet'), 'chain', 'base');
    expect(a.ok).toBe(false);
  });
  it('stablecoin-peg reads market prices only', () => {
    const t = fetchOf('stablecoin-peg');
    expect(t.fetch.tool).toBe('market_price');
    expect(t.fetch.args.ids).toEqual(['tether', 'dai', 'ethena-usde', 'paypal-usd', 'first-digital-usd']);
  });
  it('none of them sends money: email only', () => {
    for (const id of [...ids, 'stablecoin-peg']) expect(tpl(id).spec.tools).toEqual(['send_email']);
  });
});
