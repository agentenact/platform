/**
 * The panel server's only door to the api, and the only reader of PANEL_SECRET (never logged, never sent to the browser).
 *
 * `visitor: true` is an anonymous call made on behalf of a visitor: it carries the secret that proves this is the panel and
 * the VISITOR's address (from the incoming request, never this server's own), so the api's anonymous limits count the right
 * person. With no secret configured the call is not made at all: fail closed, otherwise every visitor would share one bucket.
 *
 * Traefik replaces the body of 404/500/502/503/504 with HTML, so bodies are parsed only for the statuses that carry JSON.
 */
import { PUBLIC } from '@/lib/public-config';
import { visitorIp } from './client-ip';

export interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string;
  visitor?: boolean;
  /**
   * A signed-in call to a per-IP limited route (passkey options/register): carries the bearer AND the visitor's address
   * under the panel secret, so the api's per-IP bucket counts the visitor, not this server. With no secret configured the
   * call still goes out (the owner is authenticated); it only shares the panel's bucket, the api ignores a bare x-client-ip.
   */
  forwardIp?: boolean;
}
export interface ApiResult {
  status: number;
  json: unknown | null;
}
export type ApiCall = (path: string, o?: ApiCallOptions) => Promise<ApiResult>;

/** Statuses whose JSON body passes Traefik untouched (201: a saved description answers `{ version }`; 202: agent create and retry answer `{ id }`). */
export const JSON_STATUSES: ReadonlySet<number> = new Set([200, 201, 202, 400, 401, 409, 429]);

export interface ApiDeps {
  fetch: typeof fetch;
  panelSecret(): string | undefined;
  requestHeaders(): Promise<Headers>;
  baseUrl: string;
}

export function createApiCall(d: ApiDeps): ApiCall {
  return async (path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.token) {
      headers.authorization = `Bearer ${o.token}`;
      const secret = o.forwardIp ? d.panelSecret() : undefined;
      if (secret) {
        headers['x-panel-secret'] = secret;
        const ip = visitorIp(await d.requestHeaders());
        if (ip) headers['x-client-ip'] = ip;
      }
    } else if (o.visitor) {
      const secret = d.panelSecret();
      if (!secret) throw new Error('panel_secret_missing');
      headers['x-panel-secret'] = secret;
      const ip = visitorIp(await d.requestHeaders());
      if (ip) headers['x-client-ip'] = ip;
    }
    const res = await d.fetch(`${d.baseUrl}${path}`, {
      method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      cache: 'no-store',
    });
    let json: unknown | null = null;
    if (JSON_STATUSES.has(res.status)) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  };
}

/**
 * Where this server reaches the api. API_INTERNAL_URL (e.g. http://agentenact-api:8080 on the shared overlay network) skips
 * the Cloudflare and Traefik round trip; without it, the public URL. The visitor's address still travels in x-client-ip
 * under the panel secret, so the api's per-IP limits do not depend on the route. Only an http(s) URL is accepted.
 */
export function apiBaseUrl(env: Record<string, string | undefined>): string {
  const internal = env.API_INTERNAL_URL?.trim();
  if (!internal) return PUBLIC.apiUrl;
  const url = new URL(internal);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API_INTERNAL_URL must be an http(s) URL');
  return internal.replace(/\/+$/, '');
}

export const apiCall: ApiCall = (path, o) =>
  createApiCall({
    fetch,
    baseUrl: apiBaseUrl(process.env),
    panelSecret: () => process.env.PANEL_SECRET || undefined,
    requestHeaders: async () => (await import('next/headers')).headers(),
  })(path, o);
