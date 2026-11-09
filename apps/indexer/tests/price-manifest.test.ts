import { describe, expect, it } from 'bun:test';
import { TESTNET_USDC_SAC, fetchManifest, isPrivateAddress, manifestUrlOf, readManifest, unitsToUsdc } from '../src/price-manifest.js';

const OWNER = `G${'O'.repeat(55)}`;
const WALLET = `G${'W'.repeat(55)}`;
const URL_OK = 'https://seller.example.com/.well-known/stellar-agent-services.json';
const manifest = (o: Record<string, unknown> = {}, accept: Record<string, unknown> = {}) => ({
  standard: 'stellar-agent-services/provider@1',
  provider: { name: 'Deck', agentId: 121 },
  payment: { protocol: 'x402', x402Version: 2, accepts: [{ scheme: 'exact', network: 'stellar:testnet', asset: TESTNET_USDC_SAC, payTo: OWNER, ...accept }] },
  services: [{ name: 'pitch-deck', description: 'Makes a deck', price: { amount: '1000000' } }],
  ...o,
});
const who = { agentId: 121, owner: OWNER, wallet: null };

describe('manifestUrlOf', () => {
  it('takes only the stellar-agent-services entry at the exact well-known path on https', () => {
    expect(manifestUrlOf({ services: [{ name: 'web', endpoint: 'https://x.test' }, { name: 'stellar-agent-services', endpoint: URL_OK, version: '1' }] })).toBe(URL_OK);
    for (const endpoint of [
      'http://seller.example.com/.well-known/stellar-agent-services.json',
      'https://seller.example.com:8443/.well-known/stellar-agent-services.json',
      'https://u:p@seller.example.com/.well-known/stellar-agent-services.json',
      'https://seller.example.com/other.json',
      'https://seller.example.com/.well-known/stellar-agent-services.json?x=1',
      'not a url',
    ]) expect(manifestUrlOf({ services: [{ name: 'stellar-agent-services', endpoint }] })).toBeNull();
    expect(manifestUrlOf({ services: [{ name: 'other', endpoint: URL_OK }] })).toBeNull();
    expect(manifestUrlOf(null)).toBeNull();
  });
});

describe('readManifest', () => {
  it('reads 7-decimal prices of a manifest that names this agent and pays it in testnet USDC', () => {
    expect(readManifest(manifest(), who)).toEqual([{ name: 'pitch-deck', description: 'Makes a deck', priceUsdc: '0.1' }]);
    expect(readManifest(manifest({}, { payTo: WALLET }), { ...who, wallet: WALLET })).toHaveLength(1);
  });

  it('is not this agent\'s: another id, payee, asset, network or standard', () => {
    expect(readManifest(manifest({ provider: { agentId: 122 } }), who)).toBeNull();
    expect(readManifest(manifest({}, { payTo: WALLET }), who)).toBeNull();
    expect(readManifest(manifest({}, { asset: 'CSOMEOTHERTOKEN' }), who)).toBeNull();
    expect(readManifest(manifest({}, { network: 'stellar:pubnet' }), who)).toBeNull();
    expect(readManifest(manifest({ standard: 'something/else@1' }), who)).toBeNull();
    expect(readManifest('nope', who)).toBeNull();
  });

  it('drops services without a positive whole price', () => {
    const services = [{ name: 'a', price: { amount: '0' } }, { name: 'b', price: { amount: '1.5' } }, { name: 'c', price: { amount: 5 } }, { name: 'd' }, { name: 'e', price: { amount: '25000' } }];
    expect(readManifest(manifest({ services }), who)).toEqual([{ name: 'e', description: undefined, priceUsdc: '0.0025' }]);
  });

  it('unitsToUsdc', () => {
    expect(unitsToUsdc('10000000')).toBe('1');
    expect(unitsToUsdc('12345678')).toBe('1.2345678');
    expect(unitsToUsdc('-1')).toBeNull();
    expect(unitsToUsdc('1'.repeat(14))).toBeNull();
  });
});

describe('fetchManifest', () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const pub = async () => ['93.184.216.34'];

  it('reads a public host, without following redirects', async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: string, i?: RequestInit) => ((init = i), new Response('{"a":1}'))) as unknown as typeof fetch;
    expect(await fetchManifest(URL_OK, f, pub)).toEqual({ a: 1 });
    expect(init?.redirect).toBe('error');
  });

  it('refuses private answers, IP literals and dotless hosts before any request', async () => {
    let calls = 0;
    const f = (async () => (calls++, new Response('{}'))) as unknown as typeof fetch;
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1']) {
      await expect(fetchManifest(URL_OK, f, async () => ['93.184.216.34', ip])).rejects.toThrow('blocked_host');
    }
    await expect(fetchManifest('https://10.0.0.5/.well-known/stellar-agent-services.json', f, pub)).rejects.toThrow('blocked_host');
    await expect(fetchManifest('https://db/.well-known/stellar-agent-services.json', f, pub)).rejects.toThrow('blocked_host');
    await expect(fetchManifest(URL_OK, f, async () => [])).rejects.toThrow('blocked_host');
    expect(calls).toBe(0);
  });

  it('refuses errors and bodies over 64 KB', async () => {
    await expect(fetchManifest(URL_OK, (async () => new Response('x', { status: 404 })) as unknown as typeof fetch, pub)).rejects.toThrow('status_404');
    await expect(fetchManifest(URL_OK, ok({ pad: 'x'.repeat(70_000) }), pub)).rejects.toThrow('too_large');
  });

  it('isPrivateAddress', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1')).toBe(false);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});
