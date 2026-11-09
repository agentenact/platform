/** Opening the agent's wallet on an EVM testnet, with the api injected for tests. Failures carry a plain sentence, never a body. */
import { errorCopy } from '@/copy';
import { asWallets, type OpenWalletOut } from '@/lib/wallets';
import type { ApiCall } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_TESTNET = /^(eip155:(84532|421614|43113|80002)|solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)$/;

export type { OpenWalletOut };

export function createWalletActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  return {
    async open(agentId: string, network: string): Promise<OpenWalletOut> {
      if (!UUID.test(agentId) || !EVM_TESTNET.test(network)) return { ok: false, message: errorCopy('not_found') };
      try {
        const token = await d.token();
        if (!token) return { ok: false, message: errorCopy('unauthorized') };
        const res = await d.api(`/api/agents/${agentId}/wallets/${network}`, { token, method: 'POST', body: {} });
        const wallets = res.status === 200 ? asWallets(res.json) : null;
        if (wallets) return { ok: true, wallets };
        const code = typeof (res.json as { error?: unknown } | null)?.error === 'string' ? (res.json as { error: string }).error : undefined;
        return { ok: false, message: errorCopy(code, res.status) };
      } catch {
        return { ok: false, message: errorCopy(undefined, 503) };
      }
    },
  };
}
