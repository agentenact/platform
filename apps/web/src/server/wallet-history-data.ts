/** What the agent did on chain, for the list under the activity feed. Never fatal: any failure is "no list". */
import { asHistory, type ChainHistory } from '@/lib/wallet-history';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

export type LoadHistory = (agentId: string) => Promise<ChainHistory[] | null>;

export function createLoadHistory(d: { token(): Promise<string | undefined>; api: ApiCall }): LoadHistory {
  return async (agentId) => {
    try {
      const token = await d.token();
      if (!token) return null;
      const res = await d.api(`/api/agents/${agentId}/wallets/history`, { token });
      return res.status === 200 ? asHistory(res.json) : null;
    } catch {
      return null;
    }
  };
}

export const loadHistory: LoadHistory = createLoadHistory({ token: accessToken, api: apiCall });
