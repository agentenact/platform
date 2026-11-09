/**
 * Skills routes: the owner's skills from skills.sh (skills/index.ts). Every route authenticates; agent routes touch only
 * the caller's agent. Reads that reach skills.sh or GitHub are capped per account per hour (a cached answer costs nothing); approving and removing count
 * as panel writes.
 *
 *   GET    /api/agents/:id/skills                 the agent's skills, with where each came from
 *   GET    /api/agents/:id/skills/suggestions?q=  skills matching what the agent does (q: the owner's own words, optional)
 *   GET    /api/skills/review?id=owner/repo/slug  one skill's audits, our findings and its instructions, at one commit
 *   POST   /api/agents/:id/skills                 { id, commit, contentHash, version, acceptRisk? } approve one
 *   DELETE /api/agents/:id/skills/:name?version=  remove one
 *   PUT    /api/agents/:id/services/:slug/skills   { skills: [name], version } the approved skills one paid service runs with
 *
 * Skill sets (skills/sets.ts), the owner's own; writes count as panel writes:
 *   GET    /api/skill-sets                          the owner's sets and their pinned skills
 *   GET    /api/skills/search?q=                    skills on skills.sh for no agent in particular (no q: a broad list)
 *   GET    /api/skill-sets/approved                 what the owner can pick into a new set: their agents' approved, unedited skills
 *   POST   /api/skill-sets                          { name, fromAgent? | skills? } a new set (fromAgent: copy that agent's approved skills; skills: these picks, from the owner's agents or reviewed on skills.sh)
 *   PUT    /api/skill-sets/:set                     { name } rename
 *   DELETE /api/skill-sets/:set                     delete (agents keep their skills)
 *   POST   /api/skill-sets/:set/skills              { id, commit, contentHash, revision, acceptRisk? } add one reviewed skill
 *   DELETE /api/skill-sets/:set/skills/:name?revision=  take one out (agents keep it)
 *   GET    /api/agents/:id/skill-sets               every set as this agent sees it: what applying would add, update or refuse
 *   POST   /api/agents/:id/skill-sets/:set/apply    { version, revision } apply one set as one new approved version
 */
import { httpError } from '../errors.js';
import { okSkillId, OWNER_QUERY_MAX, type SkillCatalog } from '../skills/index.js';
import { SET_NAME_MAX, type SetPick, type SkillSets } from '../skills/sets.js';
import { MAX_SERVICE_SKILLS } from '../specs/schema.js';
import type { Route } from './app.js';
import { createRateLimiter } from './rate-limit.js';
import type { RouteHelpers } from './runtime.js';

export interface SkillRouteDeps {
  catalog: SkillCatalog;
  /** Absent: the skill set routes answer 404. */
  sets?: SkillSets;
  now?: () => number;
}

/** Suggestion and review reads per account per hour (each can cost several skills.sh and GitHub requests). */
export const SKILL_READS_PER_HOUR = 60;
/** Approvals and removals per account per hour. */
export const SKILL_WRITES_PER_HOUR = 30;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const NAME = '[a-z0-9][a-z0-9-]{0,63}';
const SLUG = '[a-z0-9][a-z0-9-]{0,39}';
const NAME_RE = new RegExp(`^${NAME}$`);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const okVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const HEX64 = /^[0-9a-f]{64}$/;
const okPick = (v: unknown): v is SetPick =>
  isObject(v) && okSkillId(v.id) && typeof v.contentHash === 'string' && HEX64.test(v.contentHash) && (v.commit === undefined || typeof v.commit === 'string') && (v.acceptRisk === undefined || typeof v.acceptRisk === 'boolean');
const okSetName = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= SET_NAME_MAX * 2;

export function skillRoutes(d: SkillRouteDeps, h: RouteHelpers): Route[] {
  const o = d.now ? { now: d.now } : {};
  const reads = createRateLimiter({ name: 'skills-routes.reads', limit: SKILL_READS_PER_HOUR, windowMs: 3_600_000, ...o });
  const writes = createRateLimiter({ name: 'skills-routes.writes', limit: SKILL_WRITES_PER_HOUR, windowMs: 3_600_000, ...o });
  const limit = async (l: typeof reads, userId: string) => {
    const wait = await l.hit(userId);
    if (wait) throw Object.assign(httpError(429, 'rate_limited'), { retryAfter: wait });
  };

  const routes: Route[] = [
    ['GET', new RegExp(`^/api/agents/(${UUID})/skills$`), async (r, m) => {
      const u = await h.user(r);
      return h.json(200, await d.catalog.list(u.id, m[1]!));
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/skills/suggestions$`), async (r, m) => {
      const u = await h.user(r);
      const q = new URL(r.url).searchParams.get('q') ?? undefined;
      if (q !== undefined && q.length > OWNER_QUERY_MAX) throw httpError(400, 'bad_query');
      return h.json(200, await d.catalog.suggestions(u.id, m[1]!, q, () => limit(reads, u.id)));
    }],

    ['GET', /^\/api\/skills\/search$/, async (r) => {
      const u = await h.user(r);
      const q = new URL(r.url).searchParams.get('q') ?? undefined;
      if (q !== undefined && q.length > OWNER_QUERY_MAX) throw httpError(400, 'bad_query');
      return h.json(200, await d.catalog.search(q, () => limit(reads, u.id)));
    }],

    ['GET', /^\/api\/skills\/review$/, async (r) => {
      const u = await h.user(r);
      const id = new URL(r.url).searchParams.get('id');
      if (!okSkillId(id)) throw httpError(400, 'bad_skill_id');
      return h.json(200, await d.catalog.review(id, () => limit(reads, u.id)));
    }],

    ['POST', new RegExp(`^/api/agents/(${UUID})/skills$`), async (r, m) => {
      const u = await h.user(r);
      await limit(writes, u.id);
      const b = await h.body<{ id?: unknown; commit?: unknown; contentHash?: unknown; version?: unknown; acceptRisk?: unknown }>(r);
      if (!isObject(b) || typeof b.id !== 'string' || typeof b.commit !== 'string' || typeof b.contentHash !== 'string' || !okVersion(b.version)) throw httpError(400, 'bad_request');
      if (b.acceptRisk !== undefined && typeof b.acceptRisk !== 'boolean') throw httpError(400, 'bad_request');
      const out = await d.catalog.approve(u.id, m[1]!, { id: b.id, commit: b.commit, contentHash: b.contentHash, version: b.version, acceptRisk: b.acceptRisk === true });
      return h.json(200, out);
    }],

    ['DELETE', new RegExp(`^/api/agents/(${UUID})/skills/(${NAME})$`), async (r, m) => {
      const u = await h.user(r);
      await limit(writes, u.id);
      const raw = new URL(r.url).searchParams.get('version');
      const version = raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
      if (!okVersion(version)) throw httpError(400, 'bad_request');
      return h.json(200, await d.catalog.remove(u.id, m[1]!, m[2]!, version));
    }],

    ['PUT', new RegExp(`^/api/agents/(${UUID})/services/(${SLUG})/skills$`), async (r, m) => {
      const u = await h.user(r);
      await limit(writes, u.id);
      const b = await h.body<{ skills?: unknown; version?: unknown }>(r);
      if (!isObject(b) || !okVersion(b.version) || !Array.isArray(b.skills) || b.skills.length > MAX_SERVICE_SKILLS) throw httpError(400, 'bad_request');
      if (!b.skills.every((n): n is string => typeof n === 'string' && NAME_RE.test(n))) throw httpError(400, 'bad_request');
      return h.json(200, await d.catalog.setServiceSkills(u.id, m[1]!, m[2]!, b.skills, b.version));
    }],
  ];
  if (d.sets) routes.push(...setRoutes(d.sets, h, (u) => limit(writes, u)));
  return routes;
}

function setRoutes(sets: SkillSets, h: RouteHelpers, write: (userId: string) => Promise<void>): Route[] {
  const SET = UUID;
  return [
    ['GET', /^\/api\/skill-sets$/, async (r) => h.json(200, { sets: await sets.list((await h.user(r)).id) })],

    ['GET', /^\/api\/skill-sets\/approved$/, async (r) => h.json(200, { skills: await sets.approved((await h.user(r)).id) })],

    ['POST', /^\/api\/skill-sets$/, async (r) => {
      const u = await h.user(r);
      await write(u.id);
      const b = await h.body<{ name?: unknown; fromAgent?: unknown; skills?: unknown }>(r);
      if (!isObject(b) || !okSetName(b.name)) throw httpError(400, 'bad_name');
      if (b.skills !== undefined) {
        if (b.fromAgent !== undefined || !Array.isArray(b.skills) || !b.skills.every(okPick)) throw httpError(400, 'bad_request');
        const picks = (b.skills as SetPick[]).map(({ id, contentHash, commit, acceptRisk }) => ({ id, contentHash, ...(commit === undefined ? {} : { commit, acceptRisk: acceptRisk === true }) }));
        return h.json(200, await sets.createWith(u.id, b.name, picks));
      }
      if (b.fromAgent !== undefined && (typeof b.fromAgent !== 'string' || !new RegExp(`^${UUID}$`).test(b.fromAgent))) throw httpError(400, 'bad_request');
      return h.json(200, await sets.create(u.id, b.name, b.fromAgent?.toLowerCase()));
    }],

    ['PUT', new RegExp(`^/api/skill-sets/(${SET})$`), async (r, m) => {
      const u = await h.user(r);
      await write(u.id);
      const b = await h.body<{ name?: unknown }>(r);
      if (!isObject(b) || !okSetName(b.name)) throw httpError(400, 'bad_name');
      await sets.rename(u.id, m[1]!.toLowerCase(), b.name);
      return h.json(204, null);
    }],

    ['DELETE', new RegExp(`^/api/skill-sets/(${SET})$`), async (r, m) => {
      const u = await h.user(r);
      await write(u.id);
      await sets.remove(u.id, m[1]!.toLowerCase());
      return h.json(204, null);
    }],

    ['POST', new RegExp(`^/api/skill-sets/(${SET})/skills$`), async (r, m) => {
      const u = await h.user(r);
      await write(u.id);
      const b = await h.body<{ id?: unknown; commit?: unknown; contentHash?: unknown; revision?: unknown; acceptRisk?: unknown }>(r);
      if (!isObject(b) || typeof b.id !== 'string' || typeof b.commit !== 'string' || typeof b.contentHash !== 'string' || !okVersion(b.revision)) throw httpError(400, 'bad_request');
      if (b.acceptRisk !== undefined && typeof b.acceptRisk !== 'boolean') throw httpError(400, 'bad_request');
      return h.json(200, await sets.addSkill(u.id, m[1]!.toLowerCase(), { id: b.id, commit: b.commit, contentHash: b.contentHash, revision: b.revision, acceptRisk: b.acceptRisk === true }));
    }],

    ['DELETE', new RegExp(`^/api/skill-sets/(${SET})/skills/(${NAME})$`), async (r, m) => {
      const u = await h.user(r);
      await write(u.id);
      const raw = new URL(r.url).searchParams.get('revision');
      const revision = raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
      if (!okVersion(revision)) throw httpError(400, 'bad_request');
      return h.json(200, await sets.removeSkill(u.id, m[1]!.toLowerCase(), m[2]!, revision));
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/skill-sets$`), async (r, m) => h.json(200, await sets.forAgent((await h.user(r)).id, m[1]!))],

    ['POST', new RegExp(`^/api/agents/(${UUID})/skill-sets/(${SET})/apply$`), async (r, m) => {
      const u = await h.user(r);
      await write(u.id);
      const b = await h.body<{ version?: unknown; revision?: unknown }>(r);
      if (!isObject(b) || !okVersion(b.version) || !okVersion(b.revision)) throw httpError(400, 'bad_request');
      return h.json(200, await sets.apply(u.id, m[1]!, m[2]!.toLowerCase(), { version: b.version, revision: b.revision }));
    }],
  ];
}
