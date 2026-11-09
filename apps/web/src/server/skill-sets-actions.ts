/**
 * Skill sets, with the api injected for tests: the owner's sets, adding one reviewed skill at the commit and fingerprint
 * they saw, and applying a set to an agent at the agent version and set revision the screen showed. Failures carry a plain
 * sentence chosen from the status and code, never a body and never an error object.
 */
import { errorCopy } from '@/copy';
import { asAgentSets, asApproved, asSets, okSetId, SET_NAME_MAX, type AgentSets, type ApprovedSkill, type SkillSet } from '../lib/skill-sets';
import type { SkillOut } from '../lib/skills';
import type { ApiCall, ApiResult } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_ID = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/[a-z0-9-]{1,64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const okName = (n: string) => n.trim().length >= 1 && n.trim().length <= SET_NAME_MAX;

/** With `commit`: a skill reviewed on skills.sh at that commit. Without: one the owner's agents hold. */
export interface SetPick {
  id: string;
  contentHash: string;
  commit?: string;
  acceptRisk?: boolean;
}

export interface AddToSet {
  id: string;
  commit: string;
  contentHash: string;
  revision: number;
  acceptRisk: boolean;
}

const fail = (res: ApiResult): { ok: false; message: string } => {
  const code = (res.json as { error?: unknown } | null)?.error;
  return { ok: false, message: errorCopy(typeof code === 'string' ? code : undefined, res.status) };
};
const revisionOf = (j: unknown): { revision: number } | null => {
  const r = (j as { revision?: unknown } | null)?.revision;
  return count(r) ? { revision: r } : null;
};

const asMade = (j: unknown): { id: string; revision: number } | null => {
  const o = j as { id?: unknown; revision?: unknown } | null;
  return o && okSetId(o.id) && count(o.revision) ? { id: o.id, revision: o.revision } : null;
};

export function createSkillSetActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  async function call<T>(path: string, o: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }, parse: (json: unknown) => T | null, okStatus = 200): Promise<SkillOut<T>> {
    try {
      const token = await d.token();
      if (!token) return { ok: false, message: errorCopy('unauthorized') };
      const res = await d.api(path, { token, ...o });
      if (res.status !== okStatus) return fail(res);
      const data = parse(res.json);
      return data === null ? { ok: false, message: errorCopy(undefined, 502) } : { ok: true, data };
    } catch {
      return { ok: false, message: errorCopy(undefined, 503) };
    }
  }
  const refuse = (code = 'not_found') => Promise.resolve({ ok: false as const, message: errorCopy(code) });

  return {
    list: (): Promise<SkillOut<SkillSet[]>> => call('/api/skill-sets', {}, asSets),
    create(name: string, fromAgent?: string): Promise<SkillOut<{ id: string; revision: number }>> {
      if (!okName(name) || (fromAgent !== undefined && !UUID.test(fromAgent))) return refuse('bad_name');
      return call('/api/skill-sets', { method: 'POST', body: { name: name.trim(), ...(fromAgent ? { fromAgent } : {}) } }, asMade);
    },
    approved: (): Promise<SkillOut<ApprovedSkill[]>> => call('/api/skill-sets/approved', {}, asApproved),
    /** A new set holding the picks exactly as the screen showed them; the server copies them from the owner's agents. */
    createWith(name: string, picks: SetPick[]): Promise<SkillOut<{ id: string; revision: number }>> {
      if (!okName(name)) return refuse('bad_name');
      if (!picks.every((p) => SKILL_ID.test(p.id) && HEX64.test(p.contentHash))) return refuse();
      const body = { name: name.trim(), skills: picks.map(({ id, contentHash, commit, acceptRisk }) => ({ id, contentHash, ...(commit ? { commit, acceptRisk: acceptRisk === true } : {}) })) };
      return call('/api/skill-sets', { method: 'POST', body }, asMade);
    },
    rename(setId: string, name: string): Promise<SkillOut<true>> {
      if (!okSetId(setId)) return refuse();
      if (!okName(name)) return refuse('bad_name');
      return call(`/api/skill-sets/${setId}`, { method: 'PUT', body: { name: name.trim() } }, () => true as const, 204);
    },
    remove(setId: string): Promise<SkillOut<true>> {
      if (!okSetId(setId)) return refuse();
      return call(`/api/skill-sets/${setId}`, { method: 'DELETE' }, () => true as const, 204);
    },
    addSkill(setId: string, a: AddToSet): Promise<SkillOut<{ revision: number }>> {
      if (!okSetId(setId) || !count(a.revision) || !SKILL_ID.test(a.id)) return refuse();
      const body = { id: a.id, commit: a.commit, contentHash: a.contentHash, revision: a.revision, acceptRisk: a.acceptRisk === true };
      return call(`/api/skill-sets/${setId}/skills`, { method: 'POST', body }, revisionOf);
    },
    removeSkill(setId: string, name: string, revision: number): Promise<SkillOut<{ revision: number }>> {
      if (!okSetId(setId) || !NAME.test(name) || !count(revision)) return refuse();
      return call(`/api/skill-sets/${setId}/skills/${name}?revision=${revision}`, { method: 'DELETE' }, revisionOf);
    },
    forAgent(agentId: string): Promise<SkillOut<AgentSets>> {
      if (!UUID.test(agentId)) return refuse();
      return call(`/api/agents/${agentId}/skill-sets`, {}, asAgentSets);
    },
    apply(agentId: string, setId: string, a: { version: number; revision: number }): Promise<SkillOut<{ version: number; added: string[]; updated: string[] }>> {
      if (!UUID.test(agentId) || !okSetId(setId) || !count(a.version) || !count(a.revision)) return refuse();
      return call(`/api/agents/${agentId}/skill-sets/${setId}/apply`, { method: 'POST', body: { version: a.version, revision: a.revision } }, (j) => {
        const o = j as { version?: unknown; added?: unknown; updated?: unknown } | null;
        const names = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === 'string');
        return o && count(o.version) && names(o.added) && names(o.updated) ? { version: o.version, added: o.added, updated: o.updated } : null;
      });
    },
  };
}
