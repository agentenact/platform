/** The agent's wallets for the card on the agent page. Never fatal: any failure is "no card". */
import { asWallets, type AgentWallet } from '@/lib/wallets';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

export type LoadWallets = (agentId: string) => Promise<AgentWallet[] | null>;

export function createLoadWallets(d: { token(): Promise<string | undefined>; api: ApiCall }): LoadWallets {
  return async (agentId) => {
    try {
      const token = await d.token();
      if (!token) return null;
      const res = await d.api(`/api/agents/${agentId}/wallets`, { token });
      return res.status === 200 ? asWallets(res.json) : null;
    } catch {
      return null;
    }
  };
}

export const loadWallets: LoadWallets = createLoadWallets({ token: accessToken, api: apiCall });
