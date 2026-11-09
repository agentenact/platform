/**
 * Pause, resume and delete, with the api injected for tests. ok only when the api answers 204. Failures carry the status, never a
 * message and never an error object (Traefik hides 404/5xx bodies, so the panel branches on status).
 */
import { asLiveRun, asModelChoices, type LiveRun, type ModelChoice, type RunNowOut } from '../lib/agent-types';
import type { ApiCall } from './api';

export type PauseOut = { ok: true } | { ok: false; status: number };

export type { RunNowOut } from '../lib/agent-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  return {
    /** The owner's yes or no to the morning note. ok only on 204. */
    async setMorningNote(agentId: string, on: boolean): Promise<PauseOut> {
      if (!UUID.test(agentId)) return { ok: false, status: 400 };
      try {
        const token = await d.token();
        if (!token) return { ok: false, status: 401 };
        const res = await d.api(`/api/agents/${agentId}/morning-note`, { token, method: 'POST', body: { on } });
        return res.status === 204 ? { ok: true } : { ok: false, status: res.status };
      } catch {
        return { ok: false, status: 503 };
      }
    },

    /** The model the agent's runs use: a listed slug, or null for the default. ok only on 204. */
    async setModel(agentId: string, model: string | null): Promise<PauseOut> {
      if (!UUID.test(agentId)) return { ok: false, status: 400 };
      try {
        const token = await d.token();
        if (!token) return { ok: false, status: 401 };
        const res = await d.api(`/api/agents/${agentId}/model`, { token, method: 'POST', body: { model } });
        return res.status === 204 ? { ok: true } : { ok: false, status: res.status };
      } catch {
        return { ok: false, status: 503 };
      }
    },

    /** Every model the owner can pick (suggested first, then the OpenRouter catalog), or null on any failure. */
    async models(): Promise<ModelChoice[] | null> {
      try {
        const token = await d.token();
        if (!token) return null;
        const res = await d.api('/api/models', { token });
        const body = res.json as { models?: unknown } | null;
        return res.status === 200 && body ? asModelChoices(body.models) : null;
      } catch {
        return null;
      }
    },

    /** Deletes the agent. ok only on 202; its wallet is closed after the answer, on the api's side. */
    async remove(agentId: string): Promise<PauseOut> {
      if (!UUID.test(agentId)) return { ok: false, status: 400 };
      try {
        const token = await d.token();
        if (!token) return { ok: false, status: 401 };
        const res = await d.api(`/api/agents/${agentId}`, { token, method: 'DELETE' });
        return res.status === 202 ? { ok: true } : { ok: false, status: res.status };
      } catch {
        return { ok: false, status: 503 };
      }
    },

    /** What the agent's run is doing right now; null on any failure (the panel then just tries again). */
    async live(agentId: string): Promise<LiveRun | null> {
      if (!UUID.test(agentId)) return null;
      try {
        const token = await d.token();
        if (!token) return null;
        const res = await d.api(`/api/agents/${agentId}/live`, { token });
        return res.status === 200 ? asLiveRun(res.json) : null;
      } catch {
        return null;
      }
    },

    /** Run now. ok on 200 with a known state; anything else carries the status and, when the body has one, the api's code. */
    async runNow(agentId: string): Promise<RunNowOut> {
      if (!UUID.test(agentId)) return { ok: false, status: 400 };
      try {
        const token = await d.token();
        if (!token) return { ok: false, status: 401 };
        const res = await d.api(`/api/agents/${agentId}/run`, { token, method: 'POST', body: {} });
        const b = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as { state?: unknown; until?: unknown; error?: unknown };
        if (res.status === 200 && (b.state === 'queued' || b.state === 'running')) return { ok: true, state: b.state };
        if (res.status === 200 && b.state === 'cooling_down' && typeof b.until === 'string' && Number.isFinite(Date.parse(b.until)))
          return { ok: true, state: 'cooling_down', until: b.until };
        return { ok: false, status: res.status === 200 ? 502 : res.status, ...(typeof b.error === 'string' && /^[a-z_]{1,40}$/.test(b.error) ? { code: b.error } : {}) };
      } catch {
        return { ok: false, status: 503 };
      }
    },

    async setPaused(agentId: string, paused: boolean): Promise<PauseOut> {
      if (!UUID.test(agentId)) return { ok: false, status: 400 };
      try {
        const token = await d.token();
        if (!token) return { ok: false, status: 401 };
        const res = await d.api(`/api/agents/${agentId}/${paused ? 'pause' : 'resume'}`, { token, method: 'POST', body: {} });
        return res.status === 204 ? { ok: true } : { ok: false, status: res.status };
      } catch {
        return { ok: false, status: 503 };
      }
    },
  };
}
