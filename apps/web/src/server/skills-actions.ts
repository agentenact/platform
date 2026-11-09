/**
 * Skills from skills.sh, with the api injected for tests: suggestions, one skill's review, approving the exact files the
 * owner reviewed (the commit and our fingerprint of them go back as shown), and removing one. Failures carry a plain
 * sentence chosen from the status and code, never a body and never an error object.
 */
import { errorCopy } from '@/copy';
import { asReview, asSuggested, asSuggestions, type SkillOut, type SkillReviewShown, type SkillSuggested, type SkillSuggestions } from '../lib/skills';
import type { ApiCall, ApiResult } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_ID = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/[a-z0-9-]{1,64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const okVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

export interface ApproveSkill {
  id: string;
  commit: string;
  contentHash: string;
  version: number;
  acceptRisk: boolean;
}

const fail = (res: ApiResult): { ok: false; message: string } => {
  const code = (res.json as { error?: unknown } | null)?.error;
  return { ok: false, message: errorCopy(typeof code === 'string' ? code : undefined, res.status) };
};
const versionOf = (json: unknown): number | null => {
  const v = (json as { version?: unknown } | null)?.version;
  return okVersion(v) ? v : null;
};

export function createSkillActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  async function call<T>(path: string, o: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown }, parse: (json: unknown) => T | null): Promise<SkillOut<T>> {
    try {
      const token = await d.token();
      if (!token) return { ok: false, message: errorCopy('unauthorized') };
      const res = await d.api(path, { token, ...o });
      if (res.status !== 200) return fail(res);
      const data = parse(res.json);
      return data === null ? { ok: false, message: errorCopy(undefined, 502) } : { ok: true, data };
    } catch {
      return { ok: false, message: errorCopy(undefined, 503) };
    }
  }
  const notFound = { ok: false as const, message: errorCopy('not_found') };

  return {
    suggest(agentId: string, query?: string): Promise<SkillOut<SkillSuggestions>> {
      if (!UUID.test(agentId)) return Promise.resolve(notFound);
      const q = query?.trim().slice(0, 60);
      return call(`/api/agents/${agentId}/skills/suggestions${q ? `?q=${encodeURIComponent(q)}` : ''}`, {}, asSuggestions);
    },
    /** Skills on skills.sh for no agent in particular; no words is a broad list. */
    search(query?: string): Promise<SkillOut<SkillSuggested[]>> {
      const q = query?.trim().slice(0, 60);
      return call(`/api/skills/search${q ? `?q=${encodeURIComponent(q)}` : ''}`, {}, (j) => asSuggested((j as { suggestions?: unknown } | null)?.suggestions));
    },
    review(id: string): Promise<SkillOut<SkillReviewShown>> {
      if (!SKILL_ID.test(id) || id.split('/').some((p) => p === '.' || p === '..')) return Promise.resolve({ ok: false, message: errorCopy('bad_skill_id') });
      return call(`/api/skills/review?id=${encodeURIComponent(id)}`, {}, asReview);
    },
    approve(agentId: string, a: ApproveSkill): Promise<SkillOut<{ version: number }>> {
      if (!UUID.test(agentId) || !okVersion(a.version)) return Promise.resolve(notFound);
      const body = { id: a.id, commit: a.commit, contentHash: a.contentHash, version: a.version, acceptRisk: a.acceptRisk === true };
      return call(`/api/agents/${agentId}/skills`, { method: 'POST', body }, (j) => (versionOf(j) === null ? null : { version: versionOf(j)! }));
    },
    setOfferSkills(agentId: string, slug: string, names: string[], version: number): Promise<SkillOut<{ version: number }>> {
      if (!UUID.test(agentId) || !SLUG.test(slug) || !okVersion(version) || names.length > 2 || !names.every((n) => NAME.test(n))) return Promise.resolve(notFound);
      return call(`/api/agents/${agentId}/services/${slug}/skills`, { method: 'PUT', body: { skills: names, version } }, (j) => (versionOf(j) === null ? null : { version: versionOf(j)! }));
    },
    remove(agentId: string, name: string, version: number): Promise<SkillOut<{ version: number }>> {
      if (!UUID.test(agentId) || !NAME.test(name) || !okVersion(version)) return Promise.resolve(notFound);
      return call(`/api/agents/${agentId}/skills/${name}?version=${version}`, { method: 'DELETE' }, (j) => (versionOf(j) === null ? null : { version: versionOf(j)! }));
    },
  };
}
