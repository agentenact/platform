/**
 * Everything the agent page reads, as one outcome. Errors are status-based: the api's error bodies can be Traefik HTML,
 * so no body is ever shown or even looked at beyond a 200 answer's JSON.
 */
import { asFeed, asOverview, type FeedItem, type Overview } from '@/lib/agent-types';
import type { DraftData } from '@/lib/draft-types';
import { highlightText } from '@/lib/draft-display';
import { asSpecShown } from '@/lib/spec-types';
import type { ApiCall } from './api';
import { agentsOf, cachedApi, type AgentSummary } from './me';

export type { AgentSummary };
import { accessToken } from './session';

export type AgentLoad =
  | { kind: 'signed_out' }
  | { kind: 'no_agent' }
  | { kind: 'error' }
  | { kind: 'ready'; id: string; overview: Overview; feed: FeedItem[]; sentence?: string; draft?: DraftData };

/** One of the owner's agents, by its id from the address. An id that is not one of theirs is `no_agent`, like having none. */
export type LoadAgent = (id: string) => Promise<AgentLoad>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `wanted` when it is one of the owner's agents (ids compare case-insensitively), else null. */
function ownedId(me: unknown, wanted: string): string | null {
  if (!UUID.test(wanted)) return null;
  return agentsOf(me).find((a) => a.id.toLowerCase() === wanted.toLowerCase())?.id ?? null;
}

/**
 * The plain sentence of what the agent does, from the spec answer, for the header. Anything odd (a failed read, no active
 * description, a description that is only the name) is no sentence: the page never fails because of it.
 */
export function draftOf(json: unknown, name: string): DraftData | undefined {
  try {
    return asSpecShown(json, name)?.active?.draft ?? undefined;
  } catch {
    return undefined;
  }
}

export function sentenceOf(json: unknown, name: string): string | undefined {
  try {
    const active = asSpecShown(json, name)?.active;
    const d = active?.draft;
    // The same words the editor shows: a value with its unit, an address shortened.
    const text = d
      ? d.sentence
          .map((seg, i) => {
            if (typeof seg === 'string') return seg;
            const next = d.sentence[i + 1];
            return highlightText(d.params.find((p) => p.id === seg.param)!, typeof next === 'string' ? next : '');
          })
          .join('')
          .trim()
      : '';
    return text === '' || text === name ? undefined : text;
  } catch {
    return undefined;
  }
}

/** How long a page waits for the description before it goes on without a sentence. */
const SENTENCE_WAIT_MS = 1500;

/**
 * The spec answer for the header, never rejecting and never waiting longer than `ms`: a slow or hung read is no sentence.
 * (The api call takes no abort signal, so past the limit it is simply no longer waited for.)
 */
function readSpec(api: ApiCall, id: string, token: string, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = api(`/api/agents/${id}/spec`, { token }).then(
    (res) => (res.status === 200 ? res.json : undefined),
    () => undefined,
  );
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

export function createLoadAgent(d: { token(): Promise<string | undefined>; api: ApiCall; sentenceTimeoutMs?: number }): LoadAgent {
  return async (wanted) => {
    try {
      const token = await d.token();
      if (!token) return { kind: 'signed_out' };

      const me = await d.api('/api/me', { token });
      if (me.status === 401) return { kind: 'signed_out' };
      if (me.status !== 200 || !isObj(me.json)) return { kind: 'error' };
      const id = ownedId(me.json, wanted);
      if (!id) return { kind: 'no_agent' };

      // The header's description starts with the overview and is never waited on for long.
      const spec = readSpec(d.api, id, token, d.sentenceTimeoutMs ?? SENTENCE_WAIT_MS);
      const overviewRes = await d.api(`/api/agents/${id}/overview`, { token });
      if (overviewRes.status === 401) return { kind: 'signed_out' };
      const overview = overviewRes.status === 200 ? asOverview(overviewRes.json) : null;
      if (!overview) return { kind: 'error' };
      // Still being created: the page shows the creation flow, so there is no feed to read.
      if (overview.status === 'setting_up') return { kind: 'ready', id, overview, feed: [] };

      const feedRes = await d.api(`/api/agents/${id}/activity?days=7`, { token });
      const specJson = await spec;
      const sentence = sentenceOf(specJson, overview.name);
      // The owner's own limit, for the first-check and Today cards. Without it they simply leave the limit out.
      const draft = draftOf(specJson, overview.name);
      if (feedRes.status === 401) return { kind: 'signed_out' };
      const feed = feedRes.status === 200 ? asFeed(feedRes.json) : null;
      if (!feed) return { kind: 'error' };
      return { kind: 'ready', id, overview, feed, ...(sentence ? { sentence } : {}), ...(draft ? { draft } : {}) };
    } catch {
      // Nothing here carries the error object.
      return { kind: 'error' };
    }
  };
}

export const loadAgent: LoadAgent = createLoadAgent({ token: accessToken, api: cachedApi });

/** The owner's agents for /dashboard, or why there is no list. */
export type AgentsLoad = { kind: 'signed_out' } | { kind: 'error' } | { kind: 'ready'; agents: AgentSummary[]; limit: number | null };

export function createLoadAgents(d: { token(): Promise<string | undefined>; api: ApiCall }): () => Promise<AgentsLoad> {
  return async () => {
    try {
      const token = await d.token();
      if (!token) return { kind: 'signed_out' };
      const me = await d.api('/api/me', { token });
      if (me.status === 401) return { kind: 'signed_out' };
      if (me.status !== 200 || !isObj(me.json)) return { kind: 'error' };
      const limit = typeof me.json.agentLimit === 'number' && Number.isInteger(me.json.agentLimit) ? me.json.agentLimit : null;
      return { kind: 'ready', agents: agentsOf(me.json), limit };
    } catch {
      return { kind: 'error' };
    }
  };
}

export const loadAgents = createLoadAgents({ token: accessToken, api: cachedApi });
