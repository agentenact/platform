import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import type { ChainAdapter, Settlement } from 'agentenact';
import type { X402Server } from 'agentenact/serve';

export const TX = 'e'.repeat(64);
export const PAYER = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
export const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

/** A realistic X402Server: real v2 header codecs, testnet USDC SAC, 0.01 USDC = 100000 base units. */
export function fakeX402(payTo: string, over: Partial<X402Server> = {}): X402Server & { settled: number; verified: number } {
  const req = { scheme: 'exact', network: 'stellar:testnet', amount: '100000', asset: SAC, payTo, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } } as PaymentRequirements;
  const payload = { x402Version: 2, accepted: req, payload: { transaction: 'AAAA' } } as unknown as PaymentPayload;
  const s = {
    settled: 0,
    verified: 0,
    async accepts() {
      return [req];
    },
    async paymentRequired() {
      const header = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: 'https://public.example.test/a/x/y', description: '', mimeType: 'application/json' }, accepts: [req] });
      return { status: 402 as const, headers: { 'PAYMENT-REQUIRED': header }, body: '{}' };
    },
    async verify(h: string) {
      s.verified++;
      // 'good' and 'good-…' are valid signatures: concurrent calls need distinct ones (a copy of one in flight is refused).
      return h === 'good' || h.startsWith('good-') ? { ok: true as const, requirements: req, payload, payer: PAYER, asset: USDC_TESTNET, decimals: 7 } : { ok: false as const, reason: 'invalid_exact_stellar_payload_signature' };
    },
    async settle() {
      s.settled++;
      const responseHeader = encodePaymentResponseHeader({ success: true, transaction: TX, network: 'stellar:testnet', payer: PAYER });
      return { ok: true as const, transaction: TX, payer: PAYER, amount: '0.0100000', responseHeader };
    },
    ...over,
  };
  return s as X402Server & { settled: number; verified: number };
}

/** Real ed25519 sign/verify; settlement and identity answered for TX as Horizon/the registry would. */
export function settlementAdapter(agentAddress: string): ChainAdapter {
  const real = createStellarAdapter({ network: 'testnet' });
  const paid: Settlement = { chain: 'stellar', ref: TX, payer: PAYER, payee: agentAddress, amount: '0.0100000', asset: USDC_TESTNET, at: new Date(Date.now() - 5_000).toISOString() };
  return { ...real, readSettlement: async (ref) => (ref === TX ? [paid] : []), resolveIdentity: async () => ({ owner: agentAddress, wallet: agentAddress }) };
}
