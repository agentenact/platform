/**
 * The owner's description edits behind the "What it does" screen, with the api injected for tests. Every outcome is a plain
 * sentence chosen from the status and the api's `error` code (Traefik replaces the body of 404 and 5xx, so those are read by
 * status alone); no body text and no error object is ever passed on.
 *
 * Save is two calls in a fixed order: store the version with its sentence (PUT spec with view), then approve exactly that
 * version. If the second fails, the version number comes back so the screen can offer "Update" for it.
 */
import { errorCopy } from '@/copy';
import { asDraft, type DraftData, type OptionValue } from '../lib/draft-types';
import type { EditActions, Edit, EditOut } from '../lib/edit';
import type { ApiCall, ApiResult } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** api codes that have no sentence of their own are read as the closest one that does. */
const CODE: Record<string, string> = { bad_spec: 'bad_draft', bad_prompt: 'too_large', agent_not_active: 'not_active', agent_revoked: 'not_active', not_discardable: 'not_found', no_such_version: 'not_found' };

function failure(res: ApiResult): { ok: false; message: string } {
  if (res.status === 401) return { ok: false, message: errorCopy('unauthorized', 401) };
  const body = obj(res.json);
  const raw = str(body.error);
  const code = raw === undefined ? undefined : (CODE[raw] ?? raw);
  return { ok: false, message: errorCopy(code, res.status, str(body.code)) };
}

export type EditActionsFor = {
  [K in keyof EditActions]: EditActions[K] extends (...a: infer A) => infer R ? (agentId: string, ...a: A) => R : never;
};

export function createAgentEditActions(d: { api: ApiCall; token(): Promise<string | undefined> }): EditActionsFor {
  /** Runs one api call as the signed-in owner; any throw or missing session is a plain failure. */
  async function call(agentId: string, path: string, o: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }): Promise<ApiResult | { ok: false; message: string }> {
    if (!UUID.test(agentId)) return { ok: false, message: errorCopy('not_found') };
    try {
      const token = await d.token();
      if (!token) return { ok: false, message: errorCopy('unauthorized') };
      return await d.api(`/api/agents/${agentId}${path}`, { token, ...o });
    } catch {
      return { ok: false, message: errorCopy(undefined, 503) };
    }
  }
  const isFail = (r: ApiResult | { ok: false; message: string }): r is { ok: false; message: string } => 'ok' in r;

  const approveCall = async (agentId: string, version: number, createdAt?: string): Promise<EditOut> => {
    const r = await call(agentId, `/spec/${version}/approve`, { method: 'POST', body: createdAt ? { createdAt } : {} });
    if (isFail(r)) return r;
    return r.status === 204 ? { ok: true } : failure(r);
  };

  return {
    async edit(agentId, param: string, value: OptionValue, earlier: Edit[]) {
      const r = await call(agentId, '/builder/edit', { method: 'POST', body: { param, value, earlier } });
      if (isFail(r)) return r;
      const draft = obj(r.json).draft;
      return r.status === 200 && draft ? { ok: true, draft } : failure(r);
    },

    async save(agentId, draft: DraftData) {
      const d2 = asDraft(draft);
      if (!d2) return { ok: false, message: errorCopy('bad_draft') };
      const view = { sentence: d2.sentence, params: d2.params, bindings: d2.bindings };
      const put = await call(agentId, '/spec', { method: 'PUT', body: { spec: d2.spec, view } });
      if (isFail(put)) return put;
      const version = obj(put.json).version;
      if (put.status !== 201 || typeof version !== 'number') return failure(put);
      const approved = await approveCall(agentId, version);
      return approved.ok ? approved : { ok: false, message: approved.message, version };
    },

    async revise(agentId, prompt: string) {
      const r = await call(agentId, '/builder/draft', { method: 'POST', body: { prompt } });
      if (isFail(r)) return r;
      const b = obj(r.json);
      return r.status === 200 && typeof b.version === 'number' && b.draft ? { ok: true, version: b.version, ...(typeof b.createdAt === 'string' ? { createdAt: b.createdAt } : {}), draft: b.draft } : failure(r);
    },

    approve: (agentId, version: number, createdAt?: string) => approveCall(agentId, version, createdAt),

    async discard(agentId, version: number) {
      const r = await call(agentId, `/spec/${version}`, { method: 'DELETE' });
      if (isFail(r)) return r;
      return r.status === 204 ? { ok: true } : failure(r);
    },
  };
}
