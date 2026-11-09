import { describe, expect, it } from 'bun:test';
import { createChainReads } from '../../src/tools/chain.js';
import { createDelivery } from '../../src/tools/deliver.js';
import { createOpenRouterSearch } from '../../src/loop/search.js';
import { createMarket } from '../../src/tools/market.js';
import { createSafeFetch } from '../../src/tools/safe-fetch.js';
import { runSandboxed } from '../../src/tools/sandbox.js';
import { createWeb } from '../../src/tools/web.js';

// Opt-in. Real public APIs through the real safeFetch (no keys needed):
//   AGENTENACT_LIVE_TOOLS=1 bun test tests/e2e/tools.live.test.ts
// Tavily, the OpenRouter search fallback and Resend run only when their key is in this process's env (Kerem: hidden osascript dialog,
// as in models.live.test.ts) and, for Resend, LIVE_MAIL_TO names the inbox.
const live = process.env.AGENTENACT_LIVE_TOOLS === '1';
const sf = createSafeFetch();

describe.skipIf(!live)('tools against the real services', () => {
  it('stellar_price reads Reflector and the SDEX book on testnet', async () => {
    const p = await createChainReads({ safeFetch: sf }).stellarPrice({ symbol: 'XLM' });
    console.log(JSON.stringify(p));
    expect(Number(p.usd)).toBeGreaterThan(0);
    expect(p.ageSeconds).toBeLessThan(3600);
    expect(p.sdex?.pair).toBe('XLM/USDC (testnet SDEX)');
  }, 30_000);

  it('mainnet: the pubnet Reflector lists XLM, and stellar_price_change returns a finite changePct (read-only)', async () => {
    const chain = createChainReads({ safeFetch: sf });
    const p = await chain.stellarPrice({ symbol: 'XLM', network: 'mainnet' });
    console.log(JSON.stringify(p));
    expect(p.network).toBe('mainnet');
    expect(Number(p.usd)).toBeGreaterThan(0);
    const c = await chain.stellarPriceChange({ symbol: 'XLM', window_s: 3600, network: 'mainnet' });
    console.log(JSON.stringify(c));
    expect(Number.isFinite(c.changePct)).toBe(true);
  }, 30_000);

  it('market_price reads DefiLlama', async () => {
    const m = await createMarket({ safeFetch: sf }).marketPrice({ ids: ['stellar', 'bitcoin'] });
    console.log(JSON.stringify(m));
    expect(m.prices.stellar).toBeGreaterThan(0);
  }, 30_000);

  it('web_read extracts a real page', async () => {
    const r = await createWeb({ safeFetch: sf }).read('https://developers.stellar.org/docs');
    expect(r.text.length).toBeGreaterThan(200);
  }, 30_000);

  it('the SSRF guard refuses the cloud metadata address and a dotless host for real', async () => {
    await expect(sf('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ code: 'blocked_host' });
    await expect(sf('http://localhost/')).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('the sandbox runs under real load', async () => {
    expect(await runSandboxed('return input.n + 1', { n: 41 })).toEqual({ ok: true, value: 42 });
  });

  it.skipIf(!process.env.TAVILY_API_KEY)('web_search calls Tavily', async () => {
    const r = await createWeb({ safeFetch: sf, tavilyKey: process.env.TAVILY_API_KEY! }).search('Stellar XLM', 3, undefined, () => true);
    expect(r.results.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!process.env.OPENROUTER_API_KEY)('web_search falls back to the OpenRouter web plugin (paid, about $0.01-0.015)', async () => {
    const r = await createWeb({ safeFetch: sf, fallback: createOpenRouterSearch({ safeFetch: sf }) }).search('Stellar XLM', 3, undefined, () => true);
    console.log(JSON.stringify(r.results.map((x) => x.url)));
    expect(r.results.length).toBeGreaterThan(0);
  }, 60_000);

  it.skipIf(!process.env.RESEND_API_KEY || !process.env.LIVE_MAIL_TO)('send_email sends one plain-text mail through Resend', async () => {
    const d = createDelivery({ safeFetch: sf, resendKey: process.env.RESEND_API_KEY!, mailFrom: 'AgentEnact <agents@agentenact.io>', webhookSecret: () => '00'.repeat(32) });
    const r = await d.email(process.env.LIVE_MAIL_TO!, 'AgentEnact live check', 'Plain-text delivery check from tools.live.test.ts.');
    expect(r.id.length).toBeGreaterThan(0);
  }, 30_000);
});
