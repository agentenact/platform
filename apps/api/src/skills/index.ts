/**
 * Skills from skills.sh (agentenact/skills): the owner is offered skills that match what the agent does, sees each one's
 * partner audits and our own scan, and approves. An approved skill joins the agent's description like a hand-written one
 * (name, description, instructions; the agent loads it with `load_skill`), through the normal approval: in ONE
 * transaction with the agent row locked, spec' = the stored active version + the skill only, saved as the next version
 * and approved (approveIn). Its provenance (id, content hash, GitHub commit, audits, findings) goes in app.skill_approvals.
 *
 * What we pin and why: skills.sh audits carry no version, so the approval is bound to agentenact/skills' content hash of
 * the files the owner reviewed, read from GitHub at one commit. `approve` re-reads that commit on the server and refuses
 * if the hash differs from the one the owner was shown (409 skill_changed). The instructions are then copied into the
 * description, so a later change upstream can never reach the agent: an update is a new review and approval.
 *
 * What a skill gets: text only. Only SKILL.md's instructions are copied; scripts never run here (agents have no shell)
 * and other files are listed to the owner as unused. Nothing here touches a key, the signer or a wallet.
 *
 * Network: GETs to skills.sh (search, audits) and GitHub (api.github.com, raw.githubusercontent.com), fixed hosts, every
 * response bounded in time and size. Results are cached in memory (suggestions 1 h per agent version, reviews 1 h). One
 * search that fails or times out leaves its words out of the list; only when every search fails is the list unavailable.
 */
import {
  approveSkill,
  createGitHubSkillSource,
  createSkillsShClient,
  isSkillError,
  parseSkillManifest,
  reviewSkill,
  suggestSkills,
  type SkillAudit,
  type SkillFinding,
  type SkillPin,
  type SkillReview,
  type SkillVerdict,
} from 'agentenact/skills';
import type { Db } from '../db/index.js';
import type { DraftView } from '../builder/draft-schema.js';
import { httpError } from '../errors.js';
import { approveIn, insertVersion } from '../specs/index.js';
import { MAX_SERVICE_SKILLS, parseSpec, type AgentSpec, type SkillSpec, type ToolName } from '../specs/schema.js';

/** Searches per suggestion list (one per query). */
export const MAX_SKILL_QUERIES = 4;
/** Skills installed fewer times than this are not suggested: too new or too obscure to have meaningful audits. */
export const MIN_SKILL_INSTALLS = 10;
export const MAX_SUGGESTIONS = 8;
/** What a search with no words of the owner's looks for: skills.sh only answers searches, so "browse" is a few broad ones. */
export const BROWSE_SKILL_QUERIES: readonly string[] = ['research', 'writing', 'data analysis'];
export const SUGGEST_TTL_MS = 60 * 60_000;
/** A review is read at one GitHub commit and `approve` re-reads that commit itself, so an hour-old answer is safe to show. */
export const REVIEW_TTL_MS = 60 * 60_000;
export const SKILL_FETCH_TIMEOUT_MS = 10_000;
/** One skills.sh search: measured 0.4–3.6 s from production under load (2026-10-28). A slower one is left out of the list. */
export const SKILL_SEARCH_TIMEOUT_MS = 6_000;
export const SKILL_FETCH_MAX_BYTES = 512 * 1024;
export const OWNER_QUERY_MAX = 60;
const CACHE_MAX = 500;
/** The instructions of all skills one paid service runs with, together: they share the service's 20k-token context. */
export const MAX_SERVICE_SKILL_CHARS = 12_000;
/** AgentSpec limits a skill must fit (specs/schema.ts SkillSpec, AgentSpec.skills). */
const SPEC_SKILL_DESCRIPTION_MAX = 500;
const SPEC_SKILL_BODY_MAX = 20_000;
export const SPEC_SKILLS_MAX = 10;

/** What each tool says about the work, as a short search. Delivery and plain compute say nothing about the topic. */
const TOOL_TOPICS: Partial<Record<ToolName, string>> = {
  stellar_price: 'stellar',
  stellar_price_change: 'stellar',
  stellar_read: 'stellar',
  stellar_payments: 'stellar payments',
  wallet_payments: 'wallet payments',
  wallet_balance: 'wallet balance',
  market_price: 'crypto market',
  web_search: 'web research',
  web_read: 'web research',
  hire_agent: 'x402',
};

const STOP = new Set(
  'a an and are as at be by check checks each every for from get has have how i if in into is it its me my of on or our over please report send tell than that the their them then there these this to up us was we what when where which while who will with you your about after before daily hourly morning evening week weekly day today new latest current any all more most'.split(
    ' ',
  ),
);

/** Up to three content words of a mission: skills.sh's search finds nothing for a whole sentence, but does for a few words. */
export function missionQuery(mission: string): string | null {
  const words = mission.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  const picked = [...new Set(words)].slice(0, 3);
  return picked.length >= 1 ? picked.join(' ') : null;
}

/** The searches for one agent: the owner's words first, then each mission, then what the tools are about. */
export function skillQueries(spec: AgentSpec, ownerQuery?: string): string[] {
  const out: string[] = [];
  const add = (q: string | null | undefined) => {
    const t = q?.trim().toLowerCase();
    if (t && t.length >= 2 && !out.includes(t)) out.push(t);
  };
  add(ownerQuery);
  for (const t of spec.triggers) add(missionQuery(t.mission));
  for (const tool of spec.tools) add(TOOL_TOPICS[tool]);
  if (out.length === 0) add(missionQuery(spec.persona));
  return out.slice(0, MAX_SKILL_QUERIES);
}

export interface SkillSuggestionView {
  id: string;
  name: string;
  source: string;
  installs: number;
  url: string;
  /** The searches that found it. */
  matched: string[];
}

export interface SkillReviewView {
  id: string;
  name: string;
  description: string;
  verdict: SkillVerdict;
  audits: { provider: string; status: SkillAudit['status']; riskLevel?: string; summary: string; auditedAt: string }[];
  findings: SkillFinding[];
  /** The GitHub commit the files were read at, and our hash of them: `approve` must send both back. */
  commit: string;
  contentHash: string;
  /** SKILL.md's instructions: the only part the agent will get. */
  instructions: string;
  /** Every other file of the skill: never used here (scripts do not run, references are not loaded). */
  unused: string[];
  /** False when the instructions are too long for a description; approve answers 409 skill_unusable. */
  fits: boolean;
}

export interface ApprovedSkillView {
  name: string;
  description: string;
  /** Null for a hand-written skill. */
  source: null | {
    id: string;
    verdict: SkillVerdict;
    approvedAt: string;
    commit: string | null;
    /** The instructions were changed by hand after approval: the audits no longer describe them. */
    edited: boolean;
  };
}

/** One approved skill as a paid service gets it: its instructions, and the id and content hash its record names. */
export interface ServiceSkill {
  name: string;
  description: string;
  body: string;
  id: string;
  contentHash: string;
}

export interface ServiceSkillsView {
  slug: string;
  description: string;
  /** Names of the skills it runs with. */
  skills: string[];
}

export interface SkillCatalog {
  /** `onMiss` runs before anything reaches skills.sh or GitHub (the caller's rate limit), never on a cached answer. */
  suggestions(userId: string, agentId: string, ownerQuery?: string, onMiss?: () => unknown): Promise<{ version: number; queries: string[]; suggestions: SkillSuggestionView[] }>;
  /** Skills on skills.sh for no agent in particular: the owner's words, or a broad list without any. */
  search(ownerQuery?: string, onMiss?: () => unknown): Promise<{ suggestions: SkillSuggestionView[] }>;
  review(id: string, onMiss?: () => unknown): Promise<SkillReviewView>;
  list(userId: string, agentId: string): Promise<{ version: number; skills: ApprovedSkillView[]; services: ServiceSkillsView[] }>;
  /** Sets which approved skills one paid service runs with (`names` may be empty). Returns the new active version. */
  setServiceSkills(userId: string, agentId: string, slug: string, names: string[], version: number): Promise<{ version: number }>;
  /** `version`: the active version the owner's screen showed. Returns the new active version. */
  approve(userId: string, agentId: string, a: { id: string; commit: string; contentHash: string; version: number; acceptRisk?: boolean }): Promise<{ version: number }>;
  remove(userId: string, agentId: string, name: string, version: number): Promise<{ version: number }>;
  /**
   * One skill exactly as the owner reviewed it, approved for them: re-reads `commit` here, refuses another hash (409
   * skill_changed), a blocked or unaudited one without `acceptRisk` (409 needs_accept_risk) and one that cannot be a
   * description entry (409 skill_unusable). Writes nothing: `approve` and skill sets store what it returns.
   */
  pinned(userId: string, a: { id: string; commit: string; contentHash: string; acceptRisk?: boolean }): Promise<PinnedSkill>;
}

/** A reviewed skill, approved by its owner at one commit: what an agent's description and app.skill_approvals take. */
export interface PinnedSkill {
  skill: SkillSpec;
  entry: ReturnType<typeof approveSkill>;
  /** sha256 of `skill.body`: a later hand edit shows as edited. */
  bodySha256: string;
}

export interface SkillCatalogDeps {
  sql: Db;
  fetch?: typeof fetch;
  /** Optional: lifts GitHub's 60 requests/hour unauthenticated limit. Read-only access to public repos is all it needs. */
  githubToken?: string;
  now?: () => Date;
}

/** A fetch that gives up after `timeoutMs` and refuses bodies over `maxBytes` (counted as they stream). */
export function boundedFetch(base: typeof fetch, o: { timeoutMs: number; maxBytes: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, { ...init, signal: AbortSignal.timeout(o.timeoutMs) });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > o.maxBytes) throw new Error('response_too_large');
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > o.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('response_too_large');
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

function cache<T>(ttlMs: number, now: () => number) {
  const m = new Map<string, { at: number; value: T }>();
  return {
    get(k: string): T | undefined {
      const e = m.get(k);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        m.delete(k);
        return undefined;
      }
      return e.value;
    },
    set(k: string, value: T) {
      if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!);
      m.set(k, { at: now(), value });
    },
  };
}

/** Library failures as the gateway's fixed codes. Anything else is rethrown untouched. */
function asHttp(e: unknown): never {
  if (!isSkillError(e)) throw e;
  if (e.code === 'not_found') throw httpError(404, 'skill_not_found');
  if (e.code === 'skill_changed') throw httpError(409, 'skill_changed');
  if (e.code === 'not_approvable') throw httpError(409, 'needs_accept_risk');
  if (e.code === 'malformed' || e.code === 'bad_path') throw httpError(409, 'skill_unusable');
  throw httpError(503, 'skills_unavailable');
}

const GITHUB_ID = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/[a-z0-9-]{1,64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const okSkillId = (id: unknown): id is string => typeof id === 'string' && GITHUB_ID.test(id) && !id.split('/').some((p) => p === '.' || p === '..');

/** The description entry an approved skill becomes. Null when it cannot fit. */
export function toSpecSkill(r: SkillReview): SkillSpec | null {
  const md = r.snapshot.files.find((f) => f.path === 'SKILL.md');
  if (!md) return null;
  const body = parseSkillManifest(md.contents).body.trim();
  if (body.length < 1 || body.length > SPEC_SKILL_BODY_MAX) return null;
  const d = r.manifest.description.trim();
  const description = d.length <= SPEC_SKILL_DESCRIPTION_MAX ? d : `${d.slice(0, SPEC_SKILL_DESCRIPTION_MAX - 1)}…`;
  return { name: r.manifest.name, description, body };
}

function view(r: SkillReview): SkillReviewView {
  const pin = r.snapshot.pin;
  const md = r.snapshot.files.find((f) => f.path === 'SKILL.md');
  return {
    id: r.snapshot.id,
    name: r.manifest.name,
    description: r.manifest.description,
    verdict: r.verdict,
    audits: r.audits.map((a) => ({ provider: a.provider, status: a.status, ...(a.riskLevel ? { riskLevel: a.riskLevel } : {}), summary: a.summary, auditedAt: a.auditedAt })),
    findings: r.findings,
    commit: pin.kind === 'github' ? pin.commit : '',
    contentHash: r.snapshot.contentHash,
    instructions: md ? parseSkillManifest(md.contents).body.trim() : '',
    unused: r.snapshot.files.map((f) => f.path).filter((p) => p !== 'SKILL.md').sort(),
    fits: toSpecSkill(r) !== null,
  };
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/**
 * The skills `names` of an agent as a paid service gets them: only skills from skills.sh the owner approved and nobody
 * edited since (the body still hashes to what was approved). Anything else is left out, so a record never names a skill
 * whose text the owner did not approve. In the order given.
 */
export async function loadServiceSkills(sql: Db, agentId: string, names: readonly string[]): Promise<ServiceSkill[]> {
  // Names are skill names (a-z0-9 and hyphens: no quoting needed in the array literal); anything else reads nothing.
  if (names.length === 0 || !names.every((n) => SKILL_NAME_RE.test(n))) return [];
  const rows = (await sql`select s.name, s.description, s.body, a.skill_id, a.content_hash, a.body_sha256
                          from app.skills s join app.skill_approvals a on a.agent_id = s.agent_id and a.name = s.name
                          where s.agent_id = ${agentId} and s.name = any(${`{${names.join(',')}}`}::text[])`) as {
    name: string;
    description: string;
    body: string;
    skill_id: string;
    content_hash: string;
    body_sha256: string;
  }[];
  const by = new Map(rows.filter((r) => sha256Hex(r.body) === r.body_sha256).map((r) => [r.name, r]));
  return names.flatMap((n) => {
    const r = by.get(n);
    return r ? [{ name: r.name, description: r.description, body: r.body, id: r.skill_id, contentHash: r.content_hash }] : [];
  });
}

export interface ActiveRow {
  version: number;
  spec: AgentSpec;
  view: DraftView | null;
}

/** The caller's agent's active version, or 404 / 409. `lock` holds the agent row for the transaction. */
export async function activeOf(q: Db, userId: string, agentId: string, lock = false): Promise<ActiveRow> {
  const a = (lock
    ? await q`select status, active_spec_version from app.agents where id = ${agentId} and user_id = ${userId} for update`
    : await q`select status, active_spec_version from app.agents where id = ${agentId} and user_id = ${userId}`) as { status: string; active_spec_version: number | null }[];
  if (!a[0]) throw httpError(404, 'not_found');
  if (a[0].status !== 'active' && a[0].status !== 'paused') throw httpError(409, 'agent_not_active');
  const rows = (await q`select version, spec, view from app.agent_specs where agent_id = ${agentId} and version = ${a[0].active_spec_version}`) as ActiveRow[];
  if (!rows[0]) throw httpError(409, 'agent_not_active');
  return rows[0];
}

/** Saves spec' as the next version and approves it, inside the caller's transaction. Refuses over a pending owner draft. */
export async function saveApproved(tx: Db, agentId: string, cur: ActiveRow, next: AgentSpec, at: Date): Promise<number> {
  const pending = (await tx`select 1 from app.agent_specs where agent_id = ${agentId} and status = 'draft' and version > ${cur.version} limit 1`) as unknown[];
  // insertVersion takes max+1: a newer unapproved revision would be skipped over and lost to the owner. They decide it first.
  if (pending.length > 0) throw httpError(409, 'pending_draft');
  const version = await insertVersion(tx, agentId, next, undefined, cur.view ?? undefined);
  await approveIn(tx, agentId, version, at);
  return version;
}

/** One retry loop for a version number taken by a concurrent save (primary key 23505), as builder/suggest does. */
export async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { errno?: string } | null)?.errno === '23505' && attempt < 3) continue;
      throw e;
    }
  }
}

export function createSkillCatalog(d: SkillCatalogDeps): SkillCatalog {
  const now = d.now ?? (() => new Date());
  const ms = () => now().getTime();
  const f = boundedFetch(d.fetch ?? fetch, { timeoutMs: SKILL_FETCH_TIMEOUT_MS, maxBytes: SKILL_FETCH_MAX_BYTES });
  const skillsSh = createSkillsShClient({ fetch: f });
  const searcher = createSkillsShClient({ fetch: boundedFetch(d.fetch ?? fetch, { timeoutMs: SKILL_SEARCH_TIMEOUT_MS, maxBytes: SKILL_FETCH_MAX_BYTES }) });
  const github = createGitHubSkillSource({ fetch: f, ...(d.githubToken ? { token: d.githubToken } : {}) });
  const suggested = cache<{ version: number; queries: string[]; suggestions: SkillSuggestionView[] }>(SUGGEST_TTL_MS, ms);
  const searched = cache<{ suggestions: SkillSuggestionView[] }>(SUGGEST_TTL_MS, ms);
  const reviewed = cache<SkillReview>(REVIEW_TTL_MS, ms);

  const active = (q: Db, userId: string, agentId: string, lock = false) => activeOf(q, userId, agentId, lock);

  async function fetchReview(id: string, commit?: string): Promise<SkillReview> {
    try {
      const [snapshot, audits] = await Promise.all([github.get(id, commit), skillsSh.audits(id)]);
      return reviewSkill(snapshot, audits);
    } catch (e) {
      return asHttp(e);
    }
  }

  const saveAndApprove = (tx: Db, agentId: string, cur: ActiveRow, next: AgentSpec) => saveApproved(tx, agentId, cur, next, now());

  async function pinned(userId: string, a: { id: string; commit: string; contentHash: string; acceptRisk?: boolean }): Promise<PinnedSkill> {
    if (!okSkillId(a.id) || !COMMIT.test(a.commit) || !HEX64.test(a.contentHash)) throw httpError(400, 'bad_request');
    // Re-read the exact commit the owner reviewed, here on the server; the client's copy is never trusted.
    const r = await fetchReview(a.id, a.commit);
    if (r.snapshot.contentHash !== a.contentHash) throw httpError(409, 'skill_changed');
    let entry: ReturnType<typeof approveSkill>;
    try {
      entry = approveSkill(r, { approvedBy: userId, acceptRisk: a.acceptRisk === true, now });
    } catch (e) {
      return asHttp(e);
    }
    const skill = toSpecSkill(r);
    if (!skill) throw httpError(409, 'skill_unusable');
    return { skill, entry, bodySha256: sha256Hex(skill.body) };
  }

  /** The pinnable skills `queries` find. `complete`: no search failed; every search failing is an error. */
  async function findSkills(queries: string[]) {
    const failed: unknown[] = [];
    let found: Awaited<ReturnType<typeof suggestSkills>>;
    try {
      found = await suggestSkills({
        tasks: queries,
        search: (s) => searcher.search(s, { limit: 10 }).catch((e: unknown) => (failed.push(e), [])),
        minInstalls: MIN_SKILL_INSTALLS,
        limit: MAX_SUGGESTIONS * 2,
      });
    } catch (e) {
      return asHttp(e);
    }
    if (failed.length > 0 && failed.length === queries.length) return asHttp(failed[0]);
    // Only GitHub skills can be read at a pinned commit; a well-known (domain) source cannot be pinned, so it is not offered.
    return { found: found.filter((s) => s.listing.sourceType === 'github' && okSkillId(s.listing.id)), complete: failed.length === 0 };
  }
  const asSuggestion = (s: Awaited<ReturnType<typeof suggestSkills>>[number]): SkillSuggestionView => ({ id: s.listing.id, name: s.listing.name, source: s.listing.source, installs: s.listing.installs, url: s.listing.url, matched: s.tasks });

  return {
    async suggestions(userId, agentId, ownerQuery, onMiss) {
      const cur = await active(d.sql, userId, agentId);
      const q = ownerQuery?.trim().slice(0, OWNER_QUERY_MAX) || undefined;
      const key = `${agentId}:${cur.version}:${q ?? ''}`;
      const hit = suggested.get(key);
      if (hit) return hit;
      await onMiss?.();
      const queries = skillQueries(cur.spec, q);
      const { found, complete } = await findSkills(queries);
      const held = new Set(cur.spec.skills.map((s) => s.name));
      const approvedIds = new Set(((await d.sql`select skill_id from app.skill_approvals where agent_id = ${agentId}`) as { skill_id: string }[]).map((r) => r.skill_id));
      const suggestions = found
        .filter((s) => !approvedIds.has(s.listing.id) && !held.has(s.listing.slug))
        .slice(0, MAX_SUGGESTIONS)
        .map(asSuggestion);
      const out = { version: cur.version, queries, suggestions };
      // A list missing a failed search is shown, not kept: the next visit asks again.
      if (complete) suggested.set(key, out);
      return out;
    },

    async search(ownerQuery, onMiss) {
      const q = ownerQuery?.trim().toLowerCase().slice(0, OWNER_QUERY_MAX) ?? '';
      const hit = searched.get(q);
      if (hit) return hit;
      await onMiss?.();
      const { found, complete } = await findSkills(q.length >= 2 ? [q] : [...BROWSE_SKILL_QUERIES]);
      const out = { suggestions: found.slice(0, MAX_SUGGESTIONS).map(asSuggestion) };
      if (complete) searched.set(q, out);
      return out;
    },

    async review(id, onMiss) {
      if (!okSkillId(id)) throw httpError(400, 'bad_skill_id');
      const hit = reviewed.get(id);
      if (!hit) await onMiss?.();
      const r = hit ?? (await fetchReview(id));
      if (!hit) reviewed.set(id, r);
      return view(r);
    },

    async list(userId, agentId) {
      const cur = await active(d.sql, userId, agentId);
      const rows = (await d.sql`select name, skill_id, verdict, approved_at, pin, body_sha256 from app.skill_approvals where agent_id = ${agentId}`) as {
        name: string;
        skill_id: string;
        verdict: SkillVerdict;
        approved_at: Date;
        pin: SkillPin;
        body_sha256: string;
      }[];
      const by = new Map(rows.map((r) => [r.name, r]));
      const skills: ApprovedSkillView[] = [];
      for (const s of cur.spec.skills) {
        const r = by.get(s.name);
        skills.push({
          name: s.name,
          description: s.description,
          source: r
            ? {
                id: r.skill_id,
                verdict: r.verdict,
                approvedAt: r.approved_at.toISOString(),
                commit: r.pin.kind === 'github' ? r.pin.commit : null,
                edited: sha256Hex(s.body) !== r.body_sha256,
              }
            : null,
        });
      }
      const services = cur.spec.services.map((v) => ({ slug: v.slug, description: v.description, skills: v.skills ?? [] }));
      return { version: cur.version, skills, services };
    },

    async setServiceSkills(userId, agentId, slug, names, version) {
      if (names.length > MAX_SERVICE_SKILLS || new Set(names).size !== names.length) throw httpError(400, 'bad_request');
      return retrying(() =>
        d.sql.begin(async (t) => {
          const tx = t as unknown as Db;
          const cur = await active(tx, userId, agentId, true);
          if (cur.version !== version) throw httpError(409, 'version_changed');
          if (!cur.spec.services.some((v) => v.slug === slug)) throw httpError(404, 'service_not_found');
          // Only skills the owner approved from skills.sh and nobody edited since: the record names them by id and content hash.
          const usable = await loadServiceSkills(tx, agentId, names);
          if (usable.length !== names.length) throw httpError(409, 'skill_not_approved');
          if (usable.reduce((n, k) => n + k.body.length, 0) > MAX_SERVICE_SKILL_CHARS) throw httpError(409, 'skills_too_long');
          const services = cur.spec.services.map((v) => {
            if (v.slug !== slug) return v;
            const { skills: _old, ...rest } = v;
            return names.length > 0 ? { ...rest, skills: names } : rest;
          });
          const next = parseSpec({ ...cur.spec, services });
          if (!next.ok) throw httpError(409, 'skill_unusable');
          return { version: await saveAndApprove(tx, agentId, cur, next.spec) };
        }) as Promise<{ version: number }>,
      );
    },

    pinned,

    async approve(userId, agentId, a) {
      const { skill, entry, bodySha256: bodyHash } = await pinned(userId, a);
      return retrying(() =>
        d.sql.begin(async (t) => {
          const tx = t as unknown as Db;
          const cur = await active(tx, userId, agentId, true);
          // The screen showed `version`: if the description moved on since, the owner approves against what they see now.
          if (cur.version !== a.version) throw httpError(409, 'version_changed');
          if (cur.spec.skills.some((s) => s.name === skill.name)) throw httpError(409, 'skill_exists');
          if (cur.spec.skills.length >= SPEC_SKILLS_MAX) throw httpError(409, 'too_many_skills');
          const next = parseSpec({ ...cur.spec, skills: [...cur.spec.skills, skill] });
          if (!next.ok) throw httpError(409, 'skill_unusable');
          const version = await saveAndApprove(tx, agentId, cur, next.spec);
          await tx`delete from app.skill_approvals where agent_id = ${agentId} and (name = ${skill.name} or skill_id = ${entry.id})`;
          await tx`insert into app.skill_approvals (agent_id, name, skill_id, content_hash, pin, verdict, audits, findings, body_sha256, approved_by, approved_at, spec_version)
                   values (${agentId}, ${skill.name}, ${entry.id}, ${entry.contentHash}, ${entry.pin}, ${entry.verdict}, ${entry.audits}, ${`{${entry.findings.join(',')}}`}::text[], ${bodyHash}, ${userId}, ${entry.approvedAt}, ${version})`;
          return { version };
        }) as Promise<{ version: number }>,
      );
    },

    async remove(userId, agentId, name, version) {
      return retrying(() =>
        d.sql.begin(async (t) => {
          const tx = t as unknown as Db;
          const cur = await active(tx, userId, agentId, true);
          if (cur.version !== version) throw httpError(409, 'version_changed');
          if (!cur.spec.skills.some((s) => s.name === name)) throw httpError(404, 'skill_not_found');
          // A paid service that ran with it simply stops doing so.
          const services = cur.spec.services.map((v) => {
            if (!v.skills?.includes(name)) return v;
            const { skills, ...rest } = v;
            const left = skills.filter((n) => n !== name);
            return left.length > 0 ? { ...rest, skills: left } : rest;
          });
          const next = parseSpec({ ...cur.spec, skills: cur.spec.skills.filter((s) => s.name !== name), services });
          if (!next.ok) throw httpError(409, 'version_changed');
          const v = await saveAndApprove(tx, agentId, cur, next.spec);
          await tx`delete from app.skill_approvals where agent_id = ${agentId} and name = ${name}`;
          return { version: v };
        }) as Promise<{ version: number }>,
      );
    },
  };
}

