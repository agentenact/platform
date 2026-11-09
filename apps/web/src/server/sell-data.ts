/**
 * The selling suggestion for the agent page. Never fatal: any failure, a daily-limit answer or an odd body is "no card".
 * The first read for a description version can take a few seconds (the api writes the suggestion once); the page streams
 * this part, so the rest of the page never waits for it.
 */
import { asSellSuggestion, type SellSuggestion } from '@/lib/agent-types';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

export type LoadSuggestion = (agentId: string) => Promise<SellSuggestion | null>;

export function createLoadSuggestion(d: { token(): Promise<string | undefined>; api: ApiCall }): LoadSuggestion {
  return async (agentId) => {
    try {
      const token = await d.token();
      if (!token) return null;
      const res = await d.api(`/api/agents/${agentId}/suggestion`, { token });
      return res.status === 200 ? asSellSuggestion(res.json) : null;
    } catch {
      return null;
    }
  };
}

export const loadSuggestion: LoadSuggestion = createLoadSuggestion({ token: accessToken, api: apiCall });
