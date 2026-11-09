import { beforeAll, describe, expect, it } from 'bun:test';
import { _resetPoolForTests } from '../src/tools/isolate.js';

import { SendEmailArgs } from '../src/tools/schemas.js';
import { createHmac } from 'node:crypto';
import { nativeToScVal, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-sdk';
import { STELLAR_READ } from '../src/tools/networks.js';
import type { ToolSet } from 'ai';
import { signWebhookBody, RESEND_URL } from '../src/tools/deliver.js';
import { TRIAL_SEARCH_PER_DAY, TRIAL_SEARCH_PER_TRIAL } from '../src/policy/index.js';
import { createToolbox, type ToolboxDeps } from '../src/tools/index.js';
import { fakeSafeFetch } from './support/safe-fetch.js';
import { minimalSpec } from './support/specs.js';

beforeAll(() => _resetPoolForTests());

const ENV = { TAVILY_API_KEY: 'test-tavily', RESEND_API_KEY: 'test-resend' };
const run = (t: ToolSet[string] | undefined, input: unknown) => t!.execute!(input as never, { toolCallId: 't1', messages: [] } as never);

function deps(over: Partial<ToolboxDeps> = {}) {
  const remembered: [string, string, string][] = [];
  const sf = fakeSafeFetch((url, o) => {
    if (url === RESEND_URL) return { body: { id: 'email-1' } };
    if (url === 'https://hooks.example.com/agent') return { body: 'ok', contentType: 'text/plain' };
    if (url.startsWith('https://coins.llama.fi/')) return { body: { coins: { 'coingecko:stellar': { price: 0.22 } } } };
    return undefined;
  });
  const d: ToolboxDeps = {
    safeFetch: sf,
    memory: { remember: async (a, k, v) => (remembered.push([a, k, v]), k === 'full' ? 'full' : 'saved') },
    specs: { skillBody: async (_a, name) => (name === 'style' ? '# Short and plain.' : null) },
    policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true },
    webhookSecret: () => 'ab'.repeat(32),
    mailFrom: 'AgentEnact <agents@agentenact.io>',
    env: ENV,
    sandbox: async (code, input) => ({ ok: true, value: { code, input } }),
    now: () => 1_791_206_100_000,
    ...over,
  };
  return { d, sf, remembered };
}

describe('toolbox', () => {
  it('refuses to start without RESEND_API_KEY, but needs no search key', () => {
    expect(() => createToolbox({ ...deps().d, env: { TAVILY_API_KEY: 'x' } })).toThrow('tools: RESEND_API_KEY is not set');
    expect(() => createToolbox({ ...deps().d, env: { RESEND_API_KEY: 'x' } })).not.toThrow();
  });

  it('web_search is always available and names no provider to the model', async () => {
    const tb = createToolbox({ ...deps().d, env: { RESEND_API_KEY: 'x' } });
    const t = tb.serviceTools('a1', ['web_search']).web_search!;
    expect(t.description).not.toMatch(/brave|tavily|openrouter|exa/i);
  });

  it('web_search without Tavily takes the injected fallback, bounded by the paid cap', async () => {
    let paid = 0;
    const hit = { title: 'T', url: 'https://t.example/', description: 'd' };
    const base = deps({ env: { RESEND_API_KEY: 'x' }, fallbackSearch: async () => [hit], policy: { delivery: () => true, egress: () => true, paidSearch: () => (paid++ < 1 ? (true as const) : ('agent' as const)), trialSearch: () => true } });
    const t = createToolbox(base.d).serviceTools('a1', ['web_search']).web_search;
    expect(await run(t, { query: 'q' })).toEqual({ results: [hit] });
    await expect(run(t, { query: 'q' })).rejects.toMatchObject({ code: 'search_limit' });
  });

  it('web_search with Tavily configured spends nothing from the paid cap', async () => {
    let paid = 0;
    const sf = fakeSafeFetch((url) => (url === 'https://api.tavily.com/search' ? { body: { results: [{ title: 'S', url: 'https://s.example/', content: 'c' }] } } : undefined));
    const d = deps({ safeFetch: sf, policy: { delivery: () => true, egress: () => true, paidSearch: () => (paid++, true), trialSearch: () => true } }).d;
    const t = createToolbox(d).serviceTools('a1', ['web_search']).web_search;
    expect(await run(t, { query: 'q' })).toEqual({ results: [{ title: 'S', url: 'https://s.example/', description: 'c' }] });
    expect(paid).toBe(0);
  });

  it('owner tools are the spec tools that exist, plus remember and load_skill', () => {
    const tb = createToolbox(deps().d);
    const spec = minimalSpec({ tools: ['web_read', 'market_price', 'send_email', 'hire_agent'] });
    expect(Object.keys(tb.ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec })).sort()).toEqual(['load_skill', 'market_price', 'remember', 'send_email', 'web_read']);
  });

  it('service tools are exactly the named read tools: no memory, no delivery', () => {
    const tb = createToolbox(deps().d);
    expect(Object.keys(tb.serviceTools('a1', ['web_read', 'compute'])).sort()).toEqual(['compute', 'web_read']);
    expect(Object.keys(tb.serviceTools('a1', []))).toEqual([]);
  });

  it('send_email goes to the owner only, as plain text, through Resend', async () => {
    const { d, sf } = deps();
    const tools = createToolbox(d).ownerTools({ agentId: 'a1', ownerEmail: 'owner@example.com', mode: 'mission', spec: minimalSpec({ tools: ['send_email'] }) });
    expect(await run(tools.send_email, { subject: 'XLM alert', text: 'XLM crossed 0.30' })).toEqual({ sent: true, id: 'email-1' });
    const call = sf.calls.find((c) => c.url === RESEND_URL)!;
    expect(call.o.method).toBe('POST');
    expect(call.o.headers).toMatchObject({ authorization: 'Bearer test-resend', 'content-type': 'application/json' });
    expect(JSON.parse(String(call.o.body))).toEqual({ from: 'AgentEnact <agents@agentenact.io>', to: ['owner@example.com'], subject: 'XLM alert', text: 'XLM crossed 0.30' });
  });

  it('send_email respects the delivery limit', async () => {
    const tools = createToolbox(deps({ policy: { delivery: () => false, egress: () => true, paidSearch: () => true, trialSearch: () => true } }).d).ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec: minimalSpec({ tools: ['send_email'] }) });
    await expect(run(tools.send_email, { subject: 's', text: 't' })).rejects.toMatchObject({ code: 'email_limit' });
  });

  it('send_webhook posts to the spec URL only, signed with the agent secret', async () => {
    const { d, sf } = deps();
    const tb = createToolbox(d);
    const none = tb.ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec: minimalSpec({ tools: ['send_webhook'] }) });
    await expect(run(none.send_webhook, { text: 'x' })).rejects.toMatchObject({ code: 'no_webhook' });
    const spec = minimalSpec({ tools: ['send_webhook'], delivery: { email: false, webhook_url: 'https://hooks.example.com/agent' } });
    const tools = tb.ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec });
    expect(await run(tools.send_webhook, { text: 'hello', data: { n: 1 } })).toEqual({ sent: true, status: 200 });
    const call = sf.calls.find((c) => c.url === 'https://hooks.example.com/agent')!;
    const h = call.o.headers!;
    expect(h['x-agentenact-timestamp']).toBe('1791206100');
    const expected = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(`1791206100.${String(call.o.body)}`).digest('hex');
    expect(h['x-agentenact-signature']).toBe(`sha256=${expected}`);
    expect(signWebhookBody('ab'.repeat(32), 1791206100, String(call.o.body))).toBe(expected);
    expect(JSON.parse(String(call.o.body))).toEqual({ agentId: 'a1', sentAt: '2026-10-05T13:15:00.000Z', payload: { text: 'hello', data: { n: 1 } } });
    // a redirect would continue as a bodiless, unsigned GET and still look delivered: never follow one
    expect(call.o.maxRedirects).toBe(0);
  });

  it('send_email refuses control characters in the subject', async () => {
    expect(SendEmailArgs.safeParse({ subject: 'hi\r\nBcc: x@example.com', text: 't' }).success).toBe(false);
    expect(SendEmailArgs.safeParse({ subject: 'XLM alert', text: 't' }).success).toBe(true);
  });

  it('remember and load_skill hide storage errors behind fixed codes', async () => {
    const { d } = deps();
    const boom = async () => {
      throw new Error('relation "app.memory" does not exist');
    };
    const tools = createToolbox({ ...d, memory: { remember: boom }, specs: { skillBody: boom } }).ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec: minimalSpec() });
    await expect(run(tools.remember, { key: 'k', value: 'v' })).rejects.toMatchObject({ code: 'memory_failed' });
    await expect(run(tools.load_skill, { name: 'x' })).rejects.toMatchObject({ code: 'skill_failed' });
  });

  it('remember and load_skill', async () => {
    const { d, remembered } = deps();
    const tools = createToolbox(d).ownerTools({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'chat', spec: minimalSpec() });
    expect(await run(tools.remember, { key: 'city', value: 'Izmir' })).toEqual({ saved: true });
    expect(remembered).toEqual([['a1', 'city', 'Izmir']]);
    await expect(run(tools.remember, { key: 'full', value: 'x' })).rejects.toMatchObject({ code: 'memory_full' });
    expect(await run(tools.load_skill, { name: 'style' })).toEqual({ name: 'style', body: '# Short and plain.' });
    await expect(run(tools.load_skill, { name: 'nope' })).rejects.toMatchObject({ code: 'no_such_skill' });
  });

  it('compute runs in the sandbox and surfaces its error as a tool error', async () => {
    const ok = createToolbox(deps().d).serviceTools('a1', ['compute']);
    expect(await run(ok.compute, { code: 'return 1', input: { a: 1 } })).toEqual({ value: { code: 'return 1', input: { a: 1 } } });
    const bad = createToolbox(deps({ sandbox: async () => ({ ok: false, error: 'interrupted', fault: 'code' }) }).d).serviceTools('a1', ['compute']);
    await expect(run(bad.compute, { code: 'while(1){}' })).rejects.toMatchObject({ code: 'compute_failed' });
  });

  it('compute maps pool outcomes to fixed codes', async () => {
    for (const [error, fault, code] of [['busy', 'platform', 'busy'], ['killed', 'code', 'compute_timeout'], ['boom secret', 'code', 'compute_failed'], ['busy', 'code', 'compute_failed']] as const) {
      const t = createToolbox(deps({ sandbox: async () => ({ ok: false, error, fault }) }).d).serviceTools('a1', ['compute']);
      await expect(run(t.compute, { code: 'x' })).rejects.toMatchObject({ code });
    }
  });

  it('stellar_price description says a stale price is flagged', () => {
    const t = createToolbox(deps().d).serviceTools('a1', ['stellar_price']);
    expect(t.stellar_price!.description).toContain('stale');
  });

  it('egress-limited tools refuse past the agent limit', async () => {
    const tools = createToolbox(deps({ policy: { delivery: () => true, egress: () => false, paidSearch: () => true, trialSearch: () => true } }).d).serviceTools('a1', ['market_price']);
    await expect(run(tools.market_price, { ids: ['stellar'] })).rejects.toMatchObject({ code: 'egress_limit' });
  });

  it('conditionFetch validates the args and runs the free read tool by code', async () => {
    const tb = createToolbox(deps().d);
    expect(await tb.conditionFetch('a1', 'market_price', { ids: ['stellar'] })).toEqual({ prices: { stellar: 0.22 }, source: 'defillama' });
    await expect(tb.conditionFetch('a1', 'market_price', { ids: 'stellar' })).rejects.toMatchObject({ code: 'bad_args' });
  });

  describe('stellar_payments', () => {
    const horizon = () => fakeSafeFetch((url) => (url.startsWith('https://horizon.stellar.org/accounts/') ? { body: { _embedded: { records: [] } } } : undefined));
    const ACCT = 'GDO73LCGQTKWCEKQ55C5BUBOFKGCAXXOP6MZ35YQ6BRSQKCKDDSAWECM';
    const mission = (tools: string[]) => ({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'mission' as const, spec: { ...minimalSpec(), tools } as never });

    it('conditionFetch reads it (mainnet too); a bad argument is bad_args', async () => {
      const tb = createToolbox(deps({ safeFetch: horizon() }).d);
      expect(await tb.conditionFetch('a1', 'stellar_payments', { account: ACCT, network: 'mainnet', since_s: 300 })).toEqual({ account: ACCT, network: 'mainnet', payments: [], truncated: false });
      await expect(tb.conditionFetch('a1', 'stellar_payments', { account: ACCT, since_s: 60 })).rejects.toMatchObject({ code: 'bad_args' });
    });

    it('ownerTools exposes it only when the spec lists it; services get it, egress-limited', async () => {
      const tb = createToolbox(deps({ safeFetch: horizon() }).d);
      expect(Object.keys(tb.ownerTools(mission(['web_read'])))).not.toContain('stellar_payments');
      const t = tb.ownerTools(mission(['stellar_payments'])).stellar_payments;
      expect(await run(t, { account: ACCT, network: 'mainnet' })).toMatchObject({ network: 'mainnet', payments: [] });
      const limited = createToolbox(deps({ policy: { delivery: () => true, egress: () => false, paidSearch: () => true, trialSearch: () => true } }).d).serviceTools('a1', ['stellar_payments']);
      await expect(run(limited.stellar_payments, { account: ACCT })).rejects.toMatchObject({ code: 'egress_limit' });
    });
  });

  describe('wallet_payments / wallet_balance', () => {
    const mission = (tools: string[]) => ({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'mission' as const, spec: { ...minimalSpec(), tools } as never });
    const BTC = 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h';
    const mempool = () => fakeSafeFetch((url) => (url === `https://mempool.space/api/address/${BTC}/txs` ? { body: [] } : url === `https://mempool.space/api/address/${BTC}` ? { body: { chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } } } : undefined));
    it('conditionFetch reads both; an address of another chain is refused before any request', async () => {
      const sf = mempool();
      const tb = createToolbox(deps({ safeFetch: sf }).d);
      expect(await tb.conditionFetch('a1', 'wallet_payments', { chain: 'bitcoin', address: BTC, since_s: 420 })).toEqual({ chain: 'bitcoin', address: BTC, payments: [], truncated: false });
      expect(await tb.conditionFetch('a1', 'wallet_balance', { chain: 'bitcoin', address: BTC })).toMatchObject({ exists: true, balances: [{ symbol: 'BTC', amount: '0.00005' }] });
      const before = sf.calls.length;
      await expect(tb.conditionFetch('a1', 'wallet_balance', { chain: 'base', address: BTC })).rejects.toMatchObject({ code: 'address_not_on_chain' });
      expect(sf.calls.length).toBe(before);
      await expect(tb.conditionFetch('a1', 'wallet_balance', { chain: 'base', address: 'x' })).rejects.toMatchObject({ code: 'bad_args' });
    });
    it('owner runs get them when the spec lists them; services too, egress-limited', async () => {
      const tb = createToolbox(deps({ safeFetch: mempool() }).d);
      expect(Object.keys(tb.ownerTools(mission(['web_read'])))).not.toContain('wallet_balance');
      expect(await run(tb.ownerTools(mission(['wallet_balance'])).wallet_balance, { chain: 'bitcoin', address: BTC })).toMatchObject({ exists: true });
      const limited = createToolbox(deps({ policy: { delivery: () => true, egress: () => false, paidSearch: () => true, trialSearch: () => true } }).d).serviceTools('a1', ['wallet_payments']);
      await expect(run(limited.wallet_payments, { chain: 'bitcoin', address: BTC })).rejects.toMatchObject({ code: 'egress_limit' });
    });
  });

  describe('stellar_price_change', () => {
    const price = (p: bigint, t: bigint) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('price'), val: nativeToScVal(p, { type: 'i128' }) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('timestamp'), val: nativeToScVal(t, { type: 'u64' }) }),
      ]).toXDR('base64');
    // lastprice answers 95, price(asset, t0) answers 100; chosen by the decoded function name, not by call order.
    const feed = () =>
      fakeSafeFetch((url, o) => {
        if (url !== STELLAR_READ.mainnet.rpcUrl) return undefined;
        const { params } = JSON.parse(String(o.body)) as { params: { transaction: string } };
        const tx = TransactionBuilder.fromXDR(params.transaction, STELLAR_READ.mainnet.passphrase) as Transaction;
        const fn = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString();
        const result = fn === 'lastprice' ? price(95n * 10n ** 14n, 1_791_206_100n) : price(100n * 10n ** 14n, 1_791_202_500n);
        return { body: { jsonrpc: '2.0', id: 1, result: { latestLedger: 1, results: [{ auth: [], xdr: result }] } } };
      });
    const mission = (tools: string[]) => ({ agentId: 'a1', ownerEmail: 'o@example.com', mode: 'mission' as const, spec: { ...minimalSpec(), tools } as never });

    it('conditionFetch returns the PriceChange, mainnet included', async () => {
      const tb = createToolbox(deps({ safeFetch: feed() }).d);
      expect(await tb.conditionFetch('a1', 'stellar_price_change', { symbol: 'XLM', window_s: 3600, network: 'mainnet' })).toMatchObject({
        symbol: 'XLM',
        network: 'mainnet',
        windowSeconds: 3600,
        changePct: -5,
      });
      await expect(tb.conditionFetch('a1', 'stellar_price_change', { symbol: 'XLM', window_s: 60 })).rejects.toMatchObject({ code: 'bad_args' });
    });

    it('ownerTools exposes it only when the spec lists it, and the tool runs', async () => {
      const tb = createToolbox(deps({ safeFetch: feed() }).d);
      expect(Object.keys(tb.ownerTools(mission(['web_read'])))).not.toContain('stellar_price_change');
      const t = tb.ownerTools(mission(['stellar_price_change'])).stellar_price_change;
      expect(t).toBeDefined();
      expect(t!.description).toContain('mainnet');
      expect(await run(t, { symbol: 'XLM', window_s: 3600, network: 'mainnet' })).toMatchObject({ changePct: -5 });
    });

    it('is a service tool and egress-limited', async () => {
      const tools = createToolbox(deps({ policy: { delivery: () => true, egress: () => false, paidSearch: () => true, trialSearch: () => true } }).d).serviceTools('a1', ['stellar_price_change']);
      await expect(run(tools.stellar_price_change, { symbol: 'XLM', window_s: 3600 })).rejects.toMatchObject({ code: 'egress_limit' });
    });
  });

  describe('trialTools (P4 task 16)', () => {
    const trialSpec = () => minimalSpec({ tools: ['web_read', 'compute', 'send_email', 'send_webhook', 'hire_agent', 'market_price'], delivery: { email: true, webhook_url: 'https://hooks.example.com/agent' }, skills: [{ name: 'style', description: 'tone', body: '# Own skill body.' }] });
    const trial = (over: Partial<ToolboxDeps> = {}) => {
      const x = deps({ hire: async () => { throw new Error('hire must not run'); }, ...over });
      const wouldHave: import('../src/tools/index.js').WouldHave[] = [];
      const tools = createToolbox(x.d).trialTools({ scope: 'ip:1.2.3.4', spec: trialSpec(), wouldHave });
      return { ...x, tools, wouldHave };
    };

    describe('trial web_search budget', () => {
      const HIT = { title: 'T', url: 'https://t.example/', description: 'd' };
      const searchSpec = () => minimalSpec({ tools: ['web_search'] });
      const TAVILY = 'https://api.tavily.com/search';
      /** Tavily answers `status`; the paid fallback and every policy counter are counted. */
      function search(o: { scope: string; env?: Record<string, string>; tavily?: number; trialSearch?: () => boolean }) {
        const c = { paid: 0, fallback: 0, trial: 0 };
        const sf = fakeSafeFetch((url) => (url === TAVILY ? (o.tavily === 200 ? { body: { results: [{ title: 'S', url: 'https://s.example/', content: 'c' }] } } : { status: o.tavily ?? 429, body: {} }) : undefined));
        const x = deps({
          safeFetch: sf,
          env: o.env ?? ENV,
          fallbackSearch: async () => (c.fallback++, [HIT]),
          policy: { delivery: () => true, egress: () => true, paidSearch: () => (c.paid++, true), trialSearch: o.trialSearch ?? (() => (c.trial++, true)) },
        });
        const tools = createToolbox(x.d).trialTools({ scope: o.scope, spec: searchSpec(), wouldHave: [] });
        return { tools, c };
      }

      it('anonymous trials never use the paid search fallback', async () => {
        for (const tavily of [429, 500, 401]) {
          const { tools, c } = search({ scope: 'ip:1.2.3.4', tavily });
          expect(await run(tools.web_search, { query: 'q' })).toEqual({ results: [], note: 'search unavailable in a trial' });
          expect(c.fallback).toBe(0);
          expect(c.paid).toBe(0);
        }
        const none = search({ scope: 'ip:1.2.3.4', env: { RESEND_API_KEY: 'x' } });
        expect(await run(none.tools.web_search, { query: 'q' })).toEqual({ results: [], note: 'search unavailable in a trial' });
        expect(none.c.fallback).toBe(0);
        expect(none.c.trial).toBe(0);
      });

      it('trial searches never consume the hosted agents paid-search cap', async () => {
        const anon = search({ scope: 'ip:1.2.3.4', tavily: 200 });
        await run(anon.tools.web_search, { query: 'q' });
        const user = search({ scope: 'user:u1', tavily: 429 });
        // A signed-in trial may use the paid fallback, admitted by the trial bucket alone.
        expect(await run(user.tools.web_search, { query: 'q' })).toEqual({ results: [HIT] });
        expect(user.c.fallback).toBe(1);
        expect(user.c.trial).toBe(1);
        expect(user.c.paid).toBe(0);
        expect(anon.c.paid).toBe(0);
      });

      it('a trial stops searching after 3 and the trial bucket after its daily cap', async () => {
        const { tools } = search({ scope: 'user:u1', tavily: 200 });
        for (let i = 0; i < TRIAL_SEARCH_PER_TRIAL; i++) await run(tools.web_search, { query: 'q' });
        await expect(run(tools.web_search, { query: 'q' })).rejects.toMatchObject({ code: 'search_limit' });
        let left = TRIAL_SEARCH_PER_DAY;
        const mk = () => search({ scope: 'user:u2', tavily: 200, trialSearch: () => left-- > 0 }).tools;
        let ok = 0;
        for (let t = 0; t < 40; t++) {
          const tl = mk();
          for (let i = 0; i < TRIAL_SEARCH_PER_TRIAL; i++) {
            try {
              await run(tl.web_search, { query: 'q' });
              ok++;
            } catch (e) {
              expect((e as { code: string }).code).toBe('search_limit');
            }
          }
        }
        expect(ok).toBe(TRIAL_SEARCH_PER_DAY);
      });
    });

    it('sends no email, calls no webhook and no hire, and writes no memory', async () => {
      const { tools, sf, remembered, wouldHave } = trial();
      expect(await run(tools.send_email, { subject: 'S', text: 'body' })).toEqual({ sent: false, trial: true });
      expect(await run(tools.send_webhook, { text: 'hello' })).toEqual({ sent: false, trial: true });
      expect(await run(tools.hire_agent, { url: 'https://agent.example/svc', input: { a: 1 } })).toEqual({ sent: false, trial: true });
      expect(await run(tools.remember, { key: 'k', value: 'v' })).toEqual({ sent: false, trial: true });
      expect(sf.calls).toHaveLength(0);
      expect(remembered).toHaveLength(0);
      expect(wouldHave.map((w) => w.kind)).toEqual(['email', 'webhook', 'hire', 'remember']);
      expect(wouldHave[0]!.summary).toContain('S');
      expect(wouldHave.every((w) => w.summary.length <= 300)).toBe(true);
    });

    it('clips a long summary to 300 characters', async () => {
      const { tools, wouldHave } = trial();
      await run(tools.send_email, { subject: 'S', text: 'x'.repeat(5000) });
      expect(wouldHave[0]!.summary.length).toBeLessThanOrEqual(300);
    });

    it('read tools in a trial still run for real, on the trial egress key', async () => {
      const keys: string[] = [];
      const { tools, sf } = trial({ policy: { delivery: () => true, egress: (k) => (keys.push(k), true), paidSearch: () => true, trialSearch: () => true } });
      expect(await run(tools.market_price, { ids: ['stellar'] })).toBeDefined();
      expect(sf.calls.some((c) => c.url.startsWith('https://coins.llama.fi/'))).toBe(true);
      expect(keys).toEqual(['trial:ip:1.2.3.4']);
      expect(await run(tools.compute, { code: 'return 1', input: 2 })).toEqual({ value: { code: 'return 1', input: 2 } });
    });

    it('a spent trial egress cap refuses the read', async () => {
      const { tools } = trial({ policy: { delivery: () => true, egress: () => false, paidSearch: () => true, trialSearch: () => true } });
      await expect(run(tools.web_read, { url: 'https://example.com/' })).rejects.toMatchObject({ code: 'egress_limit' });
    });

    it('load_skill serves the spec own skills from memory; only spec tools plus remember and load_skill exist', async () => {
      const { tools } = trial();
      expect(await run(tools.load_skill, { name: 'style' })).toEqual({ name: 'style', body: '# Own skill body.' });
      await expect(run(tools.load_skill, { name: 'nope' })).rejects.toMatchObject({ code: 'no_such_skill' });
      expect(Object.keys(tools).sort()).toEqual(['compute', 'hire_agent', 'load_skill', 'market_price', 'remember', 'send_email', 'send_webhook', 'web_read']);
    });

    it('is built with no agent row, no key and no Specs', () => {
      const x = deps();
      const d = { ...x.d, specs: undefined as never, memory: undefined as never };
      expect(() => createToolbox(d).trialTools({ scope: 's', spec: trialSpec(), wouldHave: [] })).not.toThrow();
    });
  });
});
