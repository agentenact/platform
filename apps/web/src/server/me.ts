import { cache } from 'react';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

export interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

export interface Me {
  /** The first of `agents`, or null. */
  agent: AgentSummary | null;
  /** Every agent the owner holds (not revoked), oldest first. */
  agents: AgentSummary[];
  /** How many agents the account may hold; null from an api that does not say. */
  agentLimit: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The agents in a /api/me answer, oldest first. An api from before several agents only sends `agent`. Malformed entries are dropped. */
export function agentsOf(me: unknown): AgentSummary[] {
  if (!isObj(me)) return [];
  const list: unknown[] = Array.isArray(me.agents) ? me.agents : me.agent ? [me.agent] : [];
  return list.filter((a): a is AgentSummary => isObj(a) && typeof a.id === 'string' && UUID.test(a.id) && typeof a.name === 'string' && typeof a.status === 'string');
}
export type GetMe = () => Promise<Me | null>;

/** The signed-in visitor's profile, or null when signed out or the api cannot answer (the screen then shows the form). */
export function createGetMe(d: { token(): Promise<string | undefined>; api: ApiCall }): GetMe {
  return async () => {
    try {
      const token = await d.token();
      if (!token) return null;
      const res = await d.api('/api/me', { token });
      if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) return null;
      const agents = agentsOf(res.json);
      const limit = (res.json as { agentLimit?: unknown }).agentLimit;
      return { agent: agents[0] ?? null, agents, agentLimit: typeof limit === 'number' && Number.isInteger(limit) ? limit : null };
    } catch {
      return null;
    }
  };
}

type Memo = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A) => R;

/**
 * `api` with the signed-in profile read (`GET /api/me`) answered once per request: the layout header, the page's own load and
 * a section's load all need it, and with the live refresh every 30 s each extra read is an upstream call per open tab. Anything
 * else (other paths, other methods) goes straight through. `memo` is React's per-request `cache`; tests pass their own.
 */
export function withCachedMe(api: ApiCall, memo: Memo = cache as Memo): ApiCall {
  const me = memo((token: string) => api('/api/me', { token }));
  return (path, o) => (path === '/api/me' && o?.token && o.method === undefined && o.body === undefined ? me(o.token) : api(path, o));
}

/** The panel's api door with the profile read shared across one request. */
export const cachedApi: ApiCall = withCachedMe(apiCall);

/** Cached per request: the layout header and the page share one api call. */
export const getMe: GetMe = cache(createGetMe({ token: accessToken, api: cachedApi }));
