'use client';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { PUBLIC } from '@/lib/public-config';
import { bodyChunks } from './sse';
import type { ChatSessionInfo, ChatTransport, StoredTurn } from './chat';

/**
 * The chat goes from the browser straight to the api with the owner's own access token, so the stream is not held up by
 * the Next server. The api answers CORS for the app origin only. Nothing here logs the messages or the token.
 */
async function token(): Promise<string | null> {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token ?? null;
}

/** A JSON call to the owner's conversations; null on any refusal (an api without them answers 404). */
async function kept<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const t = await token();
  if (!t) return null;
  const res = await fetch(`${PUBLIC.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export const browserChatTransport: ChatTransport = {
  sessions: {
    list: async (agentId, o) => {
      const r = await kept<{ sessions: ChatSessionInfo[]; sealEach?: boolean }>('GET', `/api/chat/${agentId}/sessions${o?.archived ? '?archived=1' : ''}`);
      return r ? { sessions: r.sessions, sealEach: r.sealEach !== false } : null;
    },
    setSealEach: async (agentId, on) => (await kept<{ sealEach: boolean }>('PUT', `/api/chat/${agentId}/seal-each`, { on }))?.sealEach ?? null,
    create: async (agentId) => (await kept<{ session: ChatSessionInfo }>('POST', `/api/chat/${agentId}/sessions`))?.session ?? null,
    turns: async (agentId, sessionId) => (await kept<{ turns: StoredTurn[] }>('GET', `/api/chat/${agentId}/sessions/${sessionId}`))?.turns ?? null,
    update: async (agentId, sessionId, c) => (await kept<{ ok: boolean }>('PATCH', `/api/chat/${agentId}/sessions/${sessionId}`, c))?.ok === true,
    remove: (agentId, sessionId) => kept<{ kept: boolean }>('DELETE', `/api/chat/${agentId}/sessions/${sessionId}`),
  },
  async open(agentId, messages, signal, sessionId) {
    const t = await token();
    if (!t) return { status: 401 };
    const res = await fetch(`${PUBLIC.apiUrl}/api/chat/${agentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, accept: 'text/event-stream' },
      body: JSON.stringify(sessionId ? { sessionId, text: messages.at(-1)?.content ?? '' } : { messages }),
      cache: 'no-store',
      signal,
    });
    if (res.status === 200 && res.body) return { status: 200, chunks: bodyChunks(res.body) };
    // Traefik replaces the body of 404 and 5xx; 401, 409 and 429 keep their JSON.
    let code: string | undefined;
    if (res.status === 409 || res.status === 429 || res.status === 400) {
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === 'string') code = j.error;
      } catch {
        code = undefined;
      }
    }
    return { status: res.status, code };
  },
};
