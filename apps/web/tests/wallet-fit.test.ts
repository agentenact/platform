import { describe, expect, test } from 'bun:test';
import { TEMPLATES } from '../src/lib/templates';
import { withValues } from '../src/lib/template-values';
import { walletMismatch } from '../src/lib/wallet-fit';
import { paramDisplay } from '../src/lib/draft-display';

const watcher = TEMPLATES.find((t) => t.id === 'wallet-watch')!.draft;

describe('wallet and network', () => {
  test('a ready wallet agent starts consistent: a Stellar wallet on Stellar', () => {
    expect(walletMismatch(watcher)).toBeNull();
  });
  test('switching the network names the network the wallet does not fit, until the wallet changes too', () => {
    expect(walletMismatch(withValues(watcher, { chain: 'base' }))).toBe('Base');
    expect(walletMismatch(withValues(watcher, { chain: 'base', account: '0x4cfc111e7aa7b1594b3699cdf48521073bd723e6' }))).toBeNull();
    expect(walletMismatch(withValues(watcher, { chain: 'bitcoin', account: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h' }))).toBeNull();
    expect(walletMismatch(withValues(watcher, { chain: 'solana', account: '0x4cfc111e7aa7b1594b3699cdf48521073bd723e6' }))).toBe('Solana');
  });
  test('a draft without a wallet and network pair has nothing to say', () => {
    expect(walletMismatch(TEMPLATES.find((t) => t.id === 'xlm-drop')!.draft)).toBeNull();
  });
  test('other chains’ wallets show shortened in the sentence', () => {
    expect(paramDisplay({ id: 'account', label: 'Wallet', kind: 'text', value: '0x4cfc111e7aa7b1594b3699cdf48521073bd723e6' })).toBe('0x4cfc…23e6');
    expect(paramDisplay({ id: 'account', label: 'Wallet', kind: 'text', value: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h' })).toBe('bc1q…7s3h');
  });
  test('the multi-chain payment agents start consistent and name a wallet from another network', () => {
    for (const id of ['stablecoin-received', 'btc-received', 'quiet-wallet']) expect([id, walletMismatch(TEMPLATES.find((t) => t.id === id)!.draft)]).toEqual([id, null]);
    const received = TEMPLATES.find((t) => t.id === 'stablecoin-received')!.draft;
    expect(walletMismatch(withValues(received, { chain: 'solana' }))).toBe('Solana');
    const quiet = TEMPLATES.find((t) => t.id === 'quiet-wallet')!.draft;
    expect(walletMismatch(withValues(quiet, { chain: 'bitcoin' }))).toBe('Bitcoin');
    expect(walletMismatch(withValues(quiet, { chain: 'bitcoin', account: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h' }))).toBeNull();
  });
  test('the newer wallet agents start consistent and name a mismatch after a network switch', () => {
    for (const id of ['money-out', 'low-usdc', 'big-usdt', 'daily-balance']) {
      const d = TEMPLATES.find((t) => t.id === id)!.draft;
      expect(walletMismatch(d)).toBeNull();
      expect(walletMismatch(withValues(d, { chain: 'solana' }))).toBe('Solana');
    }
  });
});
