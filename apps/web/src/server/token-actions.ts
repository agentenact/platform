/**
 * The owner's access tokens for the owner MCP server (api /api/tokens), with the api injected for tests. Failures carry
 * the status only, never a message or an error object (Traefik hides 404/5xx bodies, so the panel branches on status).
 */
import type { TokenView } from '@/lib/key-types';
import type { ApiCall } from './api';

export type { TokenView };

export type TokensOut = { ok: true; tokens: TokenView[] } | { ok: false; status: number };
export type IssueOut = { ok: true; token: string; view: TokenView } | { ok: false; status: number };
export type RevokeOut = { ok: true } | { ok: false; status: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isView = (v: unknown): v is TokenView =>
  isObj(v) && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.hint === 'string' && typeof v.createdAt === 'string' && typeof v.expiresAt === 'string';

export function createTokenActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  async function signedIn<T extends { ok: false; status: number }>(fn: (token: string) => Promise<T | { ok: true } & object>) {
    try {
      const token = await d.token();
      if (!token) return { ok: false as const, status: 401 };
      return await fn(token);
    } catch {
      return { ok: false as const, status: 503 };
    }
  }
  return {
    list: (): Promise<TokensOut> =>
      signedIn(async (token) => {
        const res = await d.api('/api/tokens', { token });
        const list = isObj(res.json) && Array.isArray(res.json.tokens) ? (res.json.tokens.filter(isView) as TokenView[]) : null;
        return res.status === 200 && list ? { ok: true as const, tokens: list } : { ok: false as const, status: res.status };
      }) as Promise<TokensOut>,

    issue: (name: string): Promise<IssueOut> =>
      signedIn(async (token) => {
        const trimmed = name.trim();
        if (trimmed.length < 1 || trimmed.length > 64) return { ok: false as const, status: 400 };
        const res = await d.api('/api/tokens', { token, method: 'POST', body: { name: trimmed } });
        const j = res.json;
        if (res.status !== 201 || !isView(j) || !isObj(j) || typeof j.token !== 'string') return { ok: false as const, status: res.status };
        const view: TokenView = { id: j.id, name: j.name, hint: j.hint, createdAt: j.createdAt, expiresAt: j.expiresAt, lastUsedAt: typeof j.lastUsedAt === 'string' ? j.lastUsedAt : null };
        return { ok: true as const, token: j.token, view };
      }) as Promise<IssueOut>,

    revoke: (id: string): Promise<RevokeOut> =>
      signedIn(async (token) => {
        if (!UUID.test(id)) return { ok: false as const, status: 400 };
        const res = await d.api(`/api/tokens/${id}/revoke`, { token, method: 'POST', body: {} });
        return res.status === 204 ? { ok: true as const } : { ok: false as const, status: res.status };
      }) as Promise<RevokeOut>,
  };
}
