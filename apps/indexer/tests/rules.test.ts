import { describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { exclusionReason } from '../src/rules.js';
import { LOOKALIKE_ISSUER, OWNER, PAYER, USDC, WALLET } from './support/fake-chain.js';

const SPONSOR = Keypair.random().publicKey();
const cfg = { usdc: USDC, sponsors: [SPONSOR] };
const agent = { owner: OWNER, wallet: WALLET };
const t = (o: Partial<{ from: string; to: string; asset: string }> = {}) => ({ from: PAYER, to: WALLET, asset: USDC, ...o });

describe('exclusionReason', () => {
  it('excludes a non-pinned asset even with the same code', () => {
    expect(exclusionReason(t({ asset: `USDC:${LOOKALIKE_ISSUER}` }), agent, cfg)).toBe('asset');
    expect(exclusionReason(t({ asset: 'XLM' }), agent, cfg)).toBe('asset');
  });

  it('excludes the owner, the wallet itself and a configured sponsor', () => {
    expect(exclusionReason(t({ from: OWNER }), agent, cfg)).toBe('owner');
    expect(exclusionReason(t({ from: WALLET }), agent, cfg)).toBe('self');
    expect(exclusionReason(t({ from: SPONSOR }), agent, cfg)).toBe('sponsor');
  });

  it('a self-owned agent (owner === wallet) counts a payment from the owner address; a self-transfer is still self', () => {
    const own = { owner: WALLET, wallet: WALLET };
    expect(exclusionReason(t({ from: PAYER }), own, cfg)).toBeNull();
    expect(exclusionReason(t({ from: WALLET }), own, cfg)).toBe('self');
    expect(exclusionReason(t({ from: SPONSOR }), own, cfg)).toBe('sponsor');
  });

  it('checks the asset first', () => {
    expect(exclusionReason(t({ from: OWNER, asset: 'XLM' }), agent, cfg)).toBe('asset');
  });

  it('counts an unrelated payer', () => {
    expect(exclusionReason(t(), agent, cfg)).toBeNull();
    expect(exclusionReason(t(), agent, { usdc: USDC, sponsors: [] })).toBeNull();
  });

  it('compares addresses exactly (case and prefix)', () => {
    expect(exclusionReason(t({ from: OWNER.toLowerCase() }), agent, cfg)).toBeNull();
    expect(exclusionReason(t({ from: `${OWNER} ` }), agent, cfg)).toBeNull();
    expect(exclusionReason(t({ from: SPONSOR.slice(0, 20) }), agent, cfg)).toBeNull();
    expect(exclusionReason(t({ asset: USDC.toLowerCase() }), agent, cfg)).toBe('asset');
  });
});
