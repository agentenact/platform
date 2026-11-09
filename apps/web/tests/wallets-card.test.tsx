import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalletsSlot } from '../src/components/agent-screen';
import { WalletsCardView } from '../src/components/wallets-card';
import { asWallets, shortWallet, trimAmount } from '../src/lib/wallets';
import type { ApiCall } from '../src/server/api';
import { createLoadWallets } from '../src/server/wallets-data';
import { createWalletActions } from '../src/server/wallets-actions';
import { bannedWord } from '../src/lib/words';
import { AGENT_ID } from './support/agent';
import { textOf } from './support/screens';

const G = `G${'A'.repeat(55)}`;
const EVM = `0x${'ab'.repeat(20)}`;
const answer = (evm: string | null = null) => ({
  wallets: [
    { network: 'stellar:testnet', label: 'Stellar testnet', address: G, usdc: '2.5000000', explorer: `https://stellar.expert/explorer/testnet/account/${G}` },
    { network: 'eip155:84532', label: 'Base Sepolia', address: evm, usdc: evm ? '0' : null, explorer: evm ? `https://sepolia.basescan.org/address/${evm}` : null },
  ],
});
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();

describe('wallets card', () => {
  test('reads only well-formed wallets and drops a foreign explorer link', () => {
    expect(asWallets(answer())).toEqual([
      { network: 'stellar:testnet', label: 'Stellar testnet', address: G, usdc: '2.50', assets: null, explorer: `https://stellar.expert/explorer/testnet/account/${G}` },
      { network: 'eip155:84532', label: 'Base Sepolia', address: null, usdc: null, assets: null, explorer: null },
    ]);
    expect(asWallets({ wallets: [{ ...answer().wallets[0], explorer: 'https://evil.example/x' }] })![0]!.explorer).toBeNull();
    expect(asWallets({ wallets: [{ ...answer().wallets[0], address: 'not an address' }] })![0]).toMatchObject({ address: null, usdc: null });
    expect(asWallets({ wallets: [{ ...answer().wallets[0], network: 'eip155:8453x' }] })).toEqual([]);
    expect(asWallets(null)).toBeNull();
    expect([trimAmount('0'), trimAmount('1.230000'), shortWallet(EVM), shortWallet(G)]).toEqual(['0.00', '1.23', '0xabab…abab', 'GAAA…AAAA']);
  });

  test('an opened wallet shows its short address, USDC and a way to add test USDC; an unopened one an Open button; plain words only', () => {
    const html = renderToStaticMarkup(createElement(WalletsCardView, { wallets: asWallets(answer())! }));
    const t = text(html);
    expect(t).toContain('Stellar testnet');
    expect(t).toContain('GAAA…AAAA');
    expect(t).toContain('2.50 USDC');
    expect(html).toContain('data-fund="stellar:testnet"');
    expect(html).toContain('href="https://faucet.circle.com/"');
    expect(html).not.toContain('data-fund="eip155:84532"');
    expect(t).toContain('Base Sepolia');
    expect(t).toContain('Open a wallet here and your agent can pay on that network too.');
    expect(html).toContain('data-open-wallet="eip155:84532"');
    expect(bannedWord(t)).toBeNull();
    const opened = text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: asWallets(answer(EVM))! })));
    expect(opened).toContain('0xabab…abab');
    expect(opened).not.toContain('Open a wallet here');
    expect(renderToStaticMarkup(createElement(WalletsCardView, { wallets: asWallets(answer(EVM))! }))).not.toContain('data-closed-wallets');
  });

  test('a Solana devnet wallet reads as base58, links only to the Solana explorer, and opens through the same action', async () => {
    const SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const NET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    const row = (address: string | null, explorer: string | null) => ({ wallets: [{ network: NET, label: 'Solana devnet', address, usdc: address ? '0.5' : null, explorer }] });
    expect(asWallets(row(SOL, `https://explorer.solana.com/address/${SOL}?cluster=devnet`))).toEqual([
      { network: NET, label: 'Solana devnet', address: SOL, usdc: '0.50', assets: null, explorer: `https://explorer.solana.com/address/${SOL}?cluster=devnet` },
    ]);
    expect(asWallets(row(SOL, 'https://solscan.example/x'))![0]!.explorer).toBeNull();
    expect(asWallets({ wallets: [{ ...row(SOL, null).wallets[0], network: 'solana:short' }] })).toEqual([]);
    expect(shortWallet(SOL)).toBe('4zMM…ncDU');
    const closed = renderToStaticMarkup(createElement(WalletsCardView, { wallets: asWallets(row(null, null))! }));
    expect(closed).toContain(`data-open-wallet="${NET}"`);
    const calls: string[] = [];
    const api: ApiCall = async (path) => (calls.push(path), { status: 200, json: row(SOL, null) }) as never;
    const out = await createWalletActions({ api, token: async () => 't' }).open(AGENT_ID, NET);
    expect(out.ok).toBe(true);
    expect(calls).toEqual([`/api/agents/${AGENT_ID}/wallets/${NET}`]);
    expect((await createWalletActions({ api, token: async () => 't' }).open(AGENT_ID, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).ok).toBe(false);
  });

  test('the Stellar wallet says who holds its setup deposit; an unknown answer says nothing', () => {
    const with_ = (reserve: unknown) => asWallets({ wallets: [{ ...answer().wallets[0], reserve }] })!;
    expect(with_('due')[0]!.reserve).toBe('due');
    expect(with_('mine')[0]!.reserve).toBeUndefined();
    for (const r of ['free', 'due', 'self_paid'] as const) {
      const html = renderToStaticMarkup(createElement(WalletsCardView, { wallets: with_(r) }));
      expect(html).toContain(`data-wallet-reserve="${r}"`);
      expect(bannedWord(text(html))).toBeNull();
    }
    expect(text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: with_('due') })))).toContain('first top-up of 0.50');
    expect(renderToStaticMarkup(createElement(WalletsCardView, { wallets: asWallets(answer())! }))).not.toContain('data-wallet-reserve');
  });

  test('every asset the wallet holds shows, USDC first and large, then the rest; a malformed list is unknown, an unseen wallet empty', () => {
    const held = (assets: unknown) => asWallets({ wallets: [{ ...answer().wallets[0], assets }] })!;
    expect(held([{ symbol: 'XLM', amount: '10000.0000000' }, { symbol: 'USDC', amount: '2.5000000' }])[0]!.assets).toEqual([
      { symbol: 'XLM', amount: '10000.00' },
      { symbol: 'USDC', amount: '2.50' },
    ]);
    expect(held([{ symbol: 'XLM', amount: '1' }, { symbol: '<b>', amount: '1' }])[0]!.assets).toBeNull();
    expect(held([{ symbol: 'XLM', amount: '-1' }])[0]!.assets).toBeNull();
    const html = renderToStaticMarkup(createElement(WalletsCardView, { wallets: held([{ symbol: 'XLM', amount: '10000.5' }, { symbol: 'USDC', amount: '2.5' }]) }));
    const t = text(html);
    expect(t).toContain('10,000.50 XLM');
    expect(t).toContain('2.50 USDC');
    expect(t.indexOf('USDC')).toBeLessThan(t.indexOf('XLM'));
    expect(t).toContain('Testnet money only');
    expect(bannedWord(t)).toBeNull();
    expect(text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: held([]) })))).toContain('0.00 USDC Nothing held yet');
    // No USDC listed reads as zero USDC, the rest still shows.
    expect(text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: held([{ symbol: 'XLM', amount: '2' }]) })))).toContain('0.00 USDC Also 2.00 XLM');
  });

  test('a failed balance read says so, never a zero', () => {
    const w = asWallets({ wallets: [{ ...answer().wallets[0], usdc: null }] })!;
    expect(text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: w })))).toContain('Balance unavailable right now');
  });

  test('copied, faucet and error states say so in plain words', () => {
    const w = asWallets(answer(EVM))!;
    const t = text(renderToStaticMarkup(createElement(WalletsCardView, { wallets: w, copied: 'stellar:testnet', funded: 'eip155:84532', error: 'Could not open it.' })));
    expect(t).toContain('GAAA…AAAA Copied');
    expect(t).toContain('Address copied. Paste it on Circle’s faucet and pick Base Sepolia.');
    expect(t).toContain('Could not open it.');
    expect(bannedWord(t)).toBeNull();
  });

  test('the slot draws nothing for a failed read', async () => {
    expect(await WalletsSlot({ agentId: AGENT_ID, load: async () => null })).toBeNull();
    expect(await WalletsSlot({ agentId: AGENT_ID, load: async () => [] })).toBeNull();
  });

  test('the loader and the open action call the api and never show a body', async () => {
    const calls: string[] = [];
    const api: ApiCall = async (path, o) => (calls.push(`${o?.method ?? 'GET'} ${path}`), path.endsWith('/wallets') ? { status: 200, json: answer() } : { status: 409, json: { error: 'not_active' } }) as never;
    const load = createLoadWallets({ token: async () => 't', api });
    expect((await load(AGENT_ID))!.length).toBe(2);
    const open = await createWalletActions({ token: async () => 't', api }).open(AGENT_ID, 'eip155:84532');
    expect(open.ok).toBe(false);
    expect(await createWalletActions({ token: async () => 't', api }).open(AGENT_ID, 'eip155:1')).toMatchObject({ ok: false });
    expect(calls).toEqual([`GET /api/agents/${AGENT_ID}/wallets`, `POST /api/agents/${AGENT_ID}/wallets/eip155:84532`]);
    expect(await createLoadWallets({ token: async () => undefined, api })(AGENT_ID)).toBeNull();
  });
});
