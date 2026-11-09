import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnChain, sentence } from '../src/components/on-chain';
import { copy } from '../src/copy';
import { asHistory } from '../src/lib/wallet-history';
import { bannedWord } from '../src/lib/words';
import type { ApiCall } from '../src/server/api';
import { createLoadHistory } from '../src/server/wallet-history-data';
import { AGENT_ID, NOW } from './support/agent';
import { textOf } from './support/screens';

const G = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const EVM = `0x${'77'.repeat(20)}`;
const at = new Date(NOW - 3_600_000).toISOString();
const answer = {
  chains: [
    {
      network: 'stellar:testnet',
      label: 'Stellar testnet',
      state: 'ok',
      txs: [
        { hash: 'a1'.repeat(32), at, kind: 'hire', ok: true, moves: [{ direction: 'out', symbol: 'USDC', amount: '0.01' }], counterparty: G, runId: 'r', decision: { status: 'sent', tx: 'd'.repeat(64) } },
        { hash: 'a2'.repeat(32), at, kind: 'received', ok: true, moves: [{ direction: 'in', symbol: 'XLM', amount: '10000' }], counterparty: G },
      ],
    },
    {
      network: 'eip155:84532',
      label: 'Base Sepolia',
      state: 'ok',
      txs: [
        { hash: 'c1'.repeat(32), at, kind: 'swap', ok: true, moves: [{ direction: 'out', symbol: 'USDC', amount: '2.5' }, { direction: 'in', symbol: 'WETH', amount: '0.001' }], counterparty: EVM },
        { hash: 'c2'.repeat(32), at, kind: 'other', ok: false, moves: [], counterparty: EVM },
        { hash: 'c5'.repeat(32), at, kind: 'received', ok: true, moves: [{ direction: 'in', symbol: '?', amount: '1' }], counterparty: EVM },
        { hash: 'c6'.repeat(32), at, kind: 'received', ok: true, moves: [{ direction: 'in', symbol: 'TOKEN', amount: '1' }], counterparty: EVM },
      ],
    },
    { network: 'eip155:1', label: 'Elsewhere', state: 'none', txs: [] },
  ],
};
const text = (html: string) => textOf(html).replace(/\s+/g, ' ').trim();

describe('what the agent did on chain', () => {
  test('asHistory keeps well-formed rows, drops networks with no wallet, and never shows a decision that has not landed', () => {
    const h = asHistory(answer)!;
    expect(h.map((c) => [c.network, c.state, c.txs.length])).toEqual([['stellar:testnet', 'ok', 2], ['eip155:84532', 'ok', 4]]);
    expect(h[0]!.txs[0]!.decision).toEqual({ hash: 'd'.repeat(64), network: 'stellar:testnet' });
    expect(h[1]!.txs[2]!.moves[0]!.symbol).toBeNull();
    expect(h[1]!.txs[3]!.moves[0]!.symbol).toBeNull();
    const pending = asHistory({ chains: [{ ...answer.chains[0], txs: [{ ...answer.chains[0]!.txs[0], decision: { status: 'pending', tx: null } }] }] })!;
    expect(pending[0]!.txs[0]!.decision).toBeNull();
    const bad = asHistory({ chains: [{ ...answer.chains[0], txs: [{ ...answer.chains[0]!.txs[1], hash: 'x' }, { ...answer.chains[0]!.txs[1], kind: 'mint' }, { ...answer.chains[0]!.txs[1], moves: [{ direction: 'up', symbol: 'XLM', amount: '1' }] }] }] })!;
    expect(bad[0]!.txs).toEqual([]);
    expect(asHistory({ chains: [{ network: 'stellar:testnet', label: 'Stellar testnet', state: 'unavailable', txs: [] }] })).toEqual([{ network: 'stellar:testnet', label: 'Stellar testnet', state: 'unavailable', txs: [] }]);
    expect(asHistory(null)).toBeNull();
  });

  test('each row says in plain words what happened, links the explorer, and a hire links its sealed decision', () => {
    const html = renderToStaticMarkup(createElement(OnChain, { chains: asHistory(answer)!, now: NOW }));
    const t = text(html);
    expect(t).toContain('Hired an agent and paid 0.01 USDC to GAIH…ZNSR');
    expect(t).toContain('Received 10,000 XLM from GAIH…ZNSR');
    expect(t).toContain('Traded 2.5 USDC for 0.001 WETH');
    expect(t).toContain('Tried something on chain and it failed');
    expect(t).toContain('Received 1 unlisted coin from 0x7777…7777');
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${'a1'.repeat(32)}"`);
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${'d'.repeat(64)}"`);
    expect(html).toContain(`href="https://sepolia.basescan.org/tx/0x${'c1'.repeat(32)}"`);
    expect((html.match(/data-decision-link/g) ?? []).length).toBe(1);
    expect(bannedWord(t)).toBeNull();
    for (const v of Object.values(copy.onChain)) if (typeof v === 'string') expect(bannedWord(v)).toBeNull();
  });

  test('a network that could not be read says so instead of an empty list; no networks shows nothing', () => {
    const html = renderToStaticMarkup(createElement(OnChain, { chains: [{ network: 'eip155:84532', label: 'Base Sepolia', state: 'unavailable', txs: [] }], now: NOW }));
    expect(html).toContain('data-unavailable');
    expect(text(html)).toContain('Could not read this network right now');
    expect(renderToStaticMarkup(createElement(OnChain, { chains: [], now: NOW }))).toBe('');
  });

  test('sentence covers sent coins and several at once', () => {
    const tx = { tx: { hash: 'e'.repeat(64), network: 'stellar:testnet' }, at, ok: true, counterparty: null, decision: null };
    expect(sentence({ ...tx, kind: 'sent', moves: [{ direction: 'out', symbol: 'XLM', amount: '1' }, { direction: 'out', symbol: 'USDC', amount: '2' }] })).toBe('Sent 1 XLM and 2 USDC');
    expect(sentence({ ...tx, kind: 'other', moves: [] })).toBe('Used an app on chain');
  });

  test('the loader asks the api as the owner and turns any failure into no list', async () => {
    const calls: string[] = [];
    const api = (status: number, json: unknown) => (async (path: string, o?: { token?: string }) => (calls.push(`${path} ${o?.token}`), { status, json })) as ApiCall;
    expect(await createLoadHistory({ token: async () => 'tok', api: api(200, answer) })(AGENT_ID)).toHaveLength(2);
    expect(calls).toEqual([`/api/agents/${AGENT_ID}/wallets/history tok`]);
    expect(await createLoadHistory({ token: async () => 'tok', api: api(500, null) })(AGENT_ID)).toBeNull();
    expect(await createLoadHistory({ token: async () => undefined, api: api(200, answer) })(AGENT_ID)).toBeNull();
    expect(await createLoadHistory({ token: async () => 'tok', api: (async () => { throw new Error('down'); }) as ApiCall })(AGENT_ID)).toBeNull();
  });
});
