/**
 * Skill sets (Kerem, 2026-10-30): named bundles of skills from skills.sh on the owner's account, applied to an agent in
 * one step, on create or later. A set holds each skill pinned exactly as the owner approved it when adding it (the
 * catalog's `pinned`: the GitHub commit re-read on the server, the content hash, the audits, the owner's risk tick), with
 * the instructions read at that commit. Applying a set is then one transaction with no network: the agent row locked,
 * spec' = the stored active version + the set's new or newer skills, saved as the next version and approved, and one
 * app.skill_approvals row per skill, as if each had been approved one by one. Records name them the same way.
 *
 * No silent updates: an agent remembers which revision of a set it took (app.agent_skill_sets). A change to the set
 * only shows that agent as "changed"; nothing reaches it until the owner applies the set again. Taking a skill out of a
 * set never takes it off an agent, and deleting a set leaves every agent as it is.
 *
 * Applying adds what is missing, moves a skill the agent took from the same source to the set's newer pin, and leaves an
 * identical one alone. It refuses as a whole (nothing added) when a name is taken by another skill, when the agent's copy
 * was edited by hand since approval, or when the agent would hold more than SPEC_SKILLS_MAX skills.
 */
import type { SkillPin, SkillVerdict } from 'agentenact/skills';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import { parseSpec, type AgentSpec } from '../specs/schema.js';
import { activeOf, retrying, saveApproved, sha256Hex, SPEC_SKILLS_MAX, type PinnedSkill, type SkillCatalog } from './index.js';

export const MAX_SKILL_SETS = 20;
export const MAX_SET_SKILLS = SPEC_SKILLS_MAX;
export const SET_NAME_MAX = 60;

export interface SetItem {
  name: string;
  skillId: string;
  contentHash: string;
  pin: SkillPin;
  verdict: SkillVerdict;
  audits: unknown[];
  findings: string[];
  acceptRisk: boolean;
  description: string;
  body: string;
  addedAt: Date;
}

export interface SkillSetView {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  skills: { id: string; name: string; description: string; verdict: SkillVerdict; commit: string | null; addedAt: string }[];
}

/** A skill one of the owner's agents holds as approved, pickable into a new set. `agents`: who holds this exact pin. */
export interface ApprovedSkill {
  id: string;
  name: string;
  description: string;
  verdict: SkillVerdict;
  commit: string | null;
  contentHash: string;
  agents: string[];
}

export type SetConflict = { name: string; reason: 'name_taken' | 'edited' };

/** One set as one agent sees it: what applying it would do now. */
export interface AgentSetView {
  id: string;
  name: string;
  revision: number;
  /** The revision this agent last took, or null if it never took this set. */
  applied: number | null;
  /** Skills the agent does not hold yet. */
  add: string[];
  /** Skills it holds from the same source at another pin: applying moves them to the set's. */
  update: string[];
  /** Skills it already holds exactly as the set has them. */
  same: string[];
  conflicts: SetConflict[];
  /** False when the agent would hold more than MAX_SET_SKILLS skills. */
  fits: boolean;
}

export interface SetPlan {
  add: SetItem[];
  update: SetItem[];
  same: string[];
  conflicts: SetConflict[];
  fits: boolean;
}

export interface HeldApproval {
  name: string;
  skill_id: string;
  content_hash: string;
  body_sha256: string;
}

/** What applying `items` to `spec` would do, given the agent's approval rows. Pure. */
export function planSet(spec: AgentSpec, approvals: readonly HeldApproval[], items: readonly SetItem[]): SetPlan {
  const byName = new Map(approvals.map((a) => [a.name, a]));
  const byId = new Map(approvals.map((a) => [a.skill_id, a]));
  const plan: SetPlan = { add: [], update: [], same: [], conflicts: [], fits: true };
  for (const it of items) {
    const held = spec.skills.find((s) => s.name === it.name);
    const a = byName.get(it.name);
    if (held) {
      if (!a || a.skill_id !== it.skillId) plan.conflicts.push({ name: it.name, reason: 'name_taken' });
      else if (sha256Hex(held.body) !== a.body_sha256) plan.conflicts.push({ name: it.name, reason: 'edited' });
      else if (a.content_hash === it.contentHash) plan.same.push(it.name);
      else plan.update.push(it);
      continue;
    }
    // The same skill held under another name (renamed upstream since): one source, one entry.
    if (byId.has(it.skillId)) plan.conflicts.push({ name: it.name, reason: 'name_taken' });
    else plan.add.push(it);
  }
  plan.fits = spec.skills.length + plan.add.length <= MAX_SET_SKILLS;
  return plan;
}

/** `spec` with the plan's skills in: updates in place, additions after. Throws 409 when it does not parse. */
export function withSet(spec: AgentSpec, plan: SetPlan): AgentSpec {
  const up = new Map(plan.update.map((i) => [i.name, i]));
  const skills = [
    ...spec.skills.map((s) => {
      const i = up.get(s.name);
      return i ? { name: s.name, description: i.description, body: i.body } : s;
    }),
    ...plan.add.map((i) => ({ name: i.name, description: i.description, body: i.body })),
  ];
  const next = parseSpec({ ...spec, skills });
  if (!next.ok) throw httpError(409, 'skill_unusable');
  return next.spec;
}

/** The refusal for a plan that cannot be applied, if any. */
function refusal(plan: SetPlan): Error | null {
  // The screen names each conflict (forAgent); the refusal is the one code.
  if (plan.conflicts.length > 0) return httpError(409, 'set_conflict');
  if (!plan.fits) return httpError(409, 'too_many_skills');
  return null;
}

type ItemRow = {
  name: string;
  skill_id: string;
  content_hash: string;
  pin: SkillPin;
  verdict: SkillVerdict;
  audits: unknown[];
  findings: string[];
  accept_risk: boolean;
  description: string;
  body: string;
  added_at: Date;
};
const asItem = (r: ItemRow): SetItem => ({
  name: r.name,
  skillId: r.skill_id,
  contentHash: r.content_hash,
  pin: r.pin,
  verdict: r.verdict,
  audits: r.audits,
  findings: r.findings,
  acceptRisk: r.accept_risk,
  description: r.description,
  body: r.body,
  addedAt: r.added_at,
});

/**
 * The caller's set, locked for the transaction, with its skills in the order they were added. 404 for a foreign or
 * unknown set; `revision` (what the owner's screen showed) must still be current, else 409 set_changed.
 */
export async function setFor(tx: Db, userId: string, setId: string, revision?: number): Promise<{ revision: number; items: SetItem[] }> {
  const s = (await tx`select revision from app.skill_sets where id = ${setId} and user_id = ${userId} for update`) as { revision: number }[];
  if (!s[0]) throw httpError(404, 'set_not_found');
  if (revision !== undefined && s[0].revision !== revision) throw httpError(409, 'set_changed');
  const rows = (await tx`select name, skill_id, content_hash, pin, verdict, audits, findings, accept_risk, description, body, added_at
                         from app.skill_set_items where set_id = ${setId} order by added_at, name`) as ItemRow[];
  return { revision: s[0].revision, items: rows.map(asItem) };
}

/** Writes one app.skill_approvals row per applied skill (replacing an older pin of it) and remembers the set's revision. */
export async function recordSet(tx: Db, a: { agentId: string; userId: string; setId: string; revision: number; items: readonly SetItem[]; version: number; at: Date }): Promise<void> {
  for (const it of a.items) {
    await tx`delete from app.skill_approvals where agent_id = ${a.agentId} and (name = ${it.name} or skill_id = ${it.skillId})`;
    await tx`insert into app.skill_approvals (agent_id, name, skill_id, content_hash, pin, verdict, audits, findings, body_sha256, approved_by, approved_at, spec_version)
             values (${a.agentId}, ${it.name}, ${it.skillId}, ${it.contentHash}, ${it.pin}, ${it.verdict}, ${it.audits}, ${`{${it.findings.join(',')}}`}::text[], ${sha256Hex(it.body)}, ${a.userId}, ${a.at}, ${a.version})`;
  }
  await tx`insert into app.agent_skill_sets (agent_id, set_id, revision, applied_at) values (${a.agentId}, ${a.setId}, ${a.revision}, ${a.at})
           on conflict (agent_id, set_id) do update set revision = excluded.revision, applied_at = excluded.applied_at`;
}

/**
 * A new agent's description v1 with a set in it, inside agent creation's transaction (agents/index.ts): the set must be
 * the caller's and at the revision they picked; a description that cannot take it is refused, nothing is written.
 * Returns the spec to store and what to record once version 1 exists.
 */
export async function setIntoNewSpec(tx: Db, userId: string, spec: AgentSpec, pick: { id: string; revision: number }): Promise<{ spec: AgentSpec; record: (agentId: string, at: Date) => Promise<void> }> {
  const set = await setFor(tx, userId, pick.id, pick.revision);
  const plan = planSet(spec, [], set.items);
  const no = refusal(plan);
  if (no) throw no;
  const items = [...plan.add, ...plan.update];
  return {
    spec: withSet(spec, plan),
    record: (agentId, at) => recordSet(tx, { agentId, userId, setId: pick.id, revision: set.revision, items, version: 1, at }),
  };
}

export interface SkillSets {
  list(userId: string): Promise<SkillSetView[]>;
  /** What the owner can pick into a new set: every skill their agents took from skills.sh and nobody edited since, newest pin of each. */
  approved(userId: string): Promise<ApprovedSkill[]>;
  /** A new empty set, or (`fromAgent`) one holding the skills that agent took from skills.sh and nobody edited since. */
  create(userId: string, name: string, fromAgent?: string): Promise<{ id: string; revision: number }>;
  /** A new set holding the picked skills, all or nothing. */
  createWith(userId: string, name: string, picks: readonly SetPick[]): Promise<{ id: string; revision: number }>;
  rename(userId: string, setId: string, name: string): Promise<void>;
  /** Agents keep the skills they took from it. */
  remove(userId: string, setId: string): Promise<void>;
  /** Adds one reviewed skill at the commit the owner saw (the catalog's `pinned`). `revision`: what the screen showed. */
  addSkill(userId: string, setId: string, a: { id: string; commit: string; contentHash: string; acceptRisk?: boolean; revision: number }): Promise<{ revision: number }>;
  removeSkill(userId: string, setId: string, name: string, revision: number): Promise<{ revision: number }>;
  /** Every set of the owner as this agent sees it. */
  forAgent(userId: string, agentId: string): Promise<{ version: number; sets: AgentSetView[] }>;
  /** `version`: the agent's active version the screen showed; `revision`: the set's. Returns the agent's active version. */
  apply(userId: string, agentId: string, setId: string, a: { version: number; revision: number }): Promise<{ version: number; added: string[]; updated: string[] }>;
}

/**
 * One skill as the owner's screen showed it. Without `commit`: one their agents hold (`approved`), copied from there. With
 * it: a skill from skills.sh they reviewed at that commit, read again on the server like any approval (the catalog's `pinned`).
 */
export interface SetPick {
  id: string;
  contentHash: string;
  commit?: string;
  acceptRisk?: boolean;
}

/** An agent's approved skill as a set copies it: the approval row plus the instructions the agent holds. */
type Copy = HeldApproval & { pin: SkillPin; verdict: SkillVerdict; audits: unknown[]; findings: string[]; description: string; body: string };

export interface SkillSetDeps {
  sql: Db;
  catalog: Pick<SkillCatalog, 'pinned'>;
  now?: () => Date;
}

const uniqueViolation = (e: unknown) => (e as { errno?: string } | null)?.errno === '23505';
const cleanName = (n: string): string => {
  const t = n.trim().replace(/\s+/g, ' ');
  if (t.length < 1 || t.length > SET_NAME_MAX) throw httpError(400, 'bad_name');
  return t;
};

export function createSkillSets(d: SkillSetDeps): SkillSets {
  const now = d.now ?? (() => new Date());

  async function approvalsOf(q: Db, agentId: string): Promise<HeldApproval[]> {
    return (await q`select name, skill_id, content_hash, body_sha256 from app.skill_approvals where agent_id = ${agentId}`) as HeldApproval[];
  }

  /** Runs `fn` in a transaction, turning a duplicate set name into 409 name_taken. */
  async function named<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    try {
      return (await d.sql.begin((t) => fn(t as unknown as Db))) as T;
    } catch (e) {
      // The only unique key these writes can hit is (user_id, name): copied items are unique by source and name (one agent's approvals, or createWith's check).
      if (uniqueViolation(e)) throw httpError(409, 'name_taken');
      throw e;
    }
  }

  async function bump(tx: Db, setId: string): Promise<number> {
    const [r] = (await tx`update app.skill_sets set revision = revision + 1, updated_at = ${now()} where id = ${setId} returning revision`) as { revision: number }[];
    return r!.revision;
  }

  /** The user row is the lock: two creates for one account count one after the other. */
  async function newSet(tx: Db, userId: string, name: string): Promise<{ id: string; revision: number }> {
    await tx`select 1 from app.users where id = ${userId} for update`;
    const [n] = (await tx`select count(*)::int as n from app.skill_sets where user_id = ${userId}`) as { n: number }[];
    if (n!.n >= MAX_SKILL_SETS) throw httpError(409, 'too_many_sets');
    const [row] = (await tx`insert into app.skill_sets (user_id, name) values (${userId}, ${name}) returning id, revision`) as { id: string; revision: number }[];
    return row!;
  }

  async function copyInto(tx: Db, setId: string, c: Copy, at: Date): Promise<void> {
    await tx`insert into app.skill_set_items (set_id, name, skill_id, content_hash, pin, verdict, audits, findings, accept_risk, description, body, added_at)
             values (${setId}, ${c.name}, ${c.skill_id}, ${c.content_hash}, ${c.pin}, ${c.verdict}, ${c.audits}, ${`{${c.findings.join(',')}}`}::text[],
                     ${c.verdict === 'blocked' || c.verdict === 'unaudited'}, ${c.description}, ${c.body}, ${at})`;
  }

  /** Every approved skill the owner's live agents still hold unedited (a hand edit has no pin to carry), newest approval first. */
  async function copiesOf(q: Db, userId: string): Promise<(Copy & { agent: string })[]> {
    const rows = (await q`select ap.name, ap.skill_id, ap.content_hash, ap.pin, ap.verdict, ap.audits, ap.findings, ap.body_sha256, a.name as agent,
                                 sk->>'description' as description, sk->>'body' as body
                          from app.agents a
                          join app.agent_specs s on s.agent_id = a.id and s.version = a.active_spec_version
                          join app.skill_approvals ap on ap.agent_id = a.id
                          cross join lateral jsonb_array_elements(s.spec->'skills') sk
                          where a.user_id = ${userId} and a.status in ('active', 'paused') and sk->>'name' = ap.name
                          order by ap.approved_at desc, a.name`) as (Copy & { agent: string })[];
    return rows.filter((r) => sha256Hex(r.body) === r.body_sha256);
  }

  return {
    async list(userId) {
      const sets = (await d.sql`select id, name, revision, updated_at from app.skill_sets where user_id = ${userId} order by created_at, name`) as { id: string; name: string; revision: number; updated_at: Date }[];
      if (sets.length === 0) return [];
      const items = (await d.sql`select i.set_id, i.skill_id, i.name, i.description, i.verdict, i.pin, i.added_at
                                 from app.skill_set_items i join app.skill_sets s on s.id = i.set_id
                                 where s.user_id = ${userId} order by i.added_at, i.name`) as { set_id: string; skill_id: string; name: string; description: string; verdict: SkillVerdict; pin: SkillPin; added_at: Date }[];
      return sets.map((s) => ({
        id: s.id,
        name: s.name,
        revision: s.revision,
        updatedAt: s.updated_at.toISOString(),
        skills: items
          .filter((i) => i.set_id === s.id)
          .map((i) => ({ id: i.skill_id, name: i.name, description: i.description, verdict: i.verdict, commit: i.pin.kind === 'github' ? i.pin.commit : null, addedAt: i.added_at.toISOString() })),
      }));
    },

    async approved(userId) {
      const out = new Map<string, ApprovedSkill>();
      for (const c of await copiesOf(d.sql, userId)) {
        const seen = out.get(c.skill_id);
        if (!seen) out.set(c.skill_id, { id: c.skill_id, name: c.name, description: c.description, verdict: c.verdict, commit: c.pin.kind === 'github' ? c.pin.commit : null, contentHash: c.content_hash, agents: [c.agent] });
        else if (seen.contentHash === c.content_hash) seen.agents.push(c.agent);
      }
      return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    async createWith(userId, rawName, picks) {
      const name = cleanName(rawName);
      if (new Set(picks.map((p) => p.id)).size !== picks.length) throw httpError(400, 'bad_request');
      if (picks.length > MAX_SET_SKILLS) throw httpError(409, 'too_many_skills');
      // The network before the transaction: nothing is locked while GitHub answers.
      const read = await Promise.all(
        picks.map(async (p): Promise<Copy | null> => {
          if (p.commit === undefined) return null;
          const { skill, entry, bodySha256 } = await d.catalog.pinned(userId, { id: p.id, commit: p.commit, contentHash: p.contentHash, acceptRisk: p.acceptRisk === true });
          return { name: skill.name, skill_id: entry.id, content_hash: entry.contentHash, body_sha256: bodySha256, pin: entry.pin, verdict: entry.verdict, audits: entry.audits, findings: entry.findings, description: skill.description, body: skill.body };
        }),
      );
      return named(async (tx) => {
        const row = await newSet(tx, userId, name);
        const copies = await copiesOf(tx, userId);
        const chosen = picks.map((p, i) => {
          if (read[i]) return read[i];
          const c = copies.find((x) => x.skill_id === p.id && x.content_hash === p.contentHash);
          if (!c) throw httpError(409, 'skill_changed');
          return c;
        });
        if (new Set(chosen.map((c) => c.name)).size !== chosen.length) throw httpError(409, 'skill_exists');
        const at = now();
        for (const [i, c] of chosen.entries()) await copyInto(tx, row.id, c, new Date(at.getTime() + i));
        return row;
      });
    },

    async create(userId, rawName, fromAgent) {
      const name = cleanName(rawName);
      return named(async (tx) => {
        const row = await newSet(tx, userId, name);
        if (fromAgent) {
          const cur = await activeOf(tx, userId, fromAgent);
          const rows = (await tx`select name, skill_id, content_hash, pin, verdict, audits, findings, body_sha256 from app.skill_approvals where agent_id = ${fromAgent}`) as (HeldApproval & { pin: SkillPin; verdict: SkillVerdict; audits: unknown[]; findings: string[] })[];
          const by = new Map(rows.map((r) => [r.name, r]));
          const at = now();
          let added = 0;
          for (const s of cur.spec.skills) {
            const a = by.get(s.name);
            // Only what came from skills.sh and still reads as approved: a hand-written or hand-edited skill has no pin to carry.
            if (!a || sha256Hex(s.body) !== a.body_sha256) continue;
            await copyInto(tx, row.id, { ...a, description: s.description, body: s.body }, new Date(at.getTime() + added++));
          }
          if (added === 0) throw httpError(409, 'no_skills_to_copy');
        }
        return row;
      });
    },

    async rename(userId, setId, rawName) {
      const name = cleanName(rawName);
      await named(async (tx) => {
        const done = (await tx`update app.skill_sets set name = ${name}, updated_at = ${now()} where id = ${setId} and user_id = ${userId} returning id`) as unknown[];
        if (done.length === 0) throw httpError(404, 'set_not_found');
      });
    },

    async remove(userId, setId) {
      const done = (await d.sql`delete from app.skill_sets where id = ${setId} and user_id = ${userId} returning id`) as unknown[];
      if (done.length === 0) throw httpError(404, 'set_not_found');
    },

    async addSkill(userId, setId, a) {
      // Owner check first: a foreign set never costs a GitHub read.
      const own = (await d.sql`select 1 from app.skill_sets where id = ${setId} and user_id = ${userId}`) as unknown[];
      if (own.length === 0) throw httpError(404, 'set_not_found');
      const p: PinnedSkill = await d.catalog.pinned(userId, a);
      return d.sql.begin(async (t) => {
        const tx = t as unknown as Db;
        const set = await setFor(tx, userId, setId, a.revision);
        const same = set.items.find((i) => i.skillId === p.entry.id);
        if (same && same.contentHash === p.entry.contentHash) return { revision: set.revision };
        if (set.items.some((i) => i.name === p.skill.name && i.skillId !== p.entry.id)) throw httpError(409, 'skill_exists');
        if (!same && set.items.length >= MAX_SET_SKILLS) throw httpError(409, 'too_many_skills');
        // A newer pin of a skill already in the set replaces it (its place in the set moves to now).
        await tx`delete from app.skill_set_items where set_id = ${setId} and skill_id = ${p.entry.id}`;
        await tx`insert into app.skill_set_items (set_id, name, skill_id, content_hash, pin, verdict, audits, findings, accept_risk, description, body, added_at)
                 values (${setId}, ${p.skill.name}, ${p.entry.id}, ${p.entry.contentHash}, ${p.entry.pin}, ${p.entry.verdict}, ${p.entry.audits}, ${`{${p.entry.findings.join(',')}}`}::text[],
                         ${a.acceptRisk === true}, ${p.skill.description}, ${p.skill.body}, ${now()})`;
        return { revision: await bump(tx, setId) };
      }) as Promise<{ revision: number }>;
    },

    async removeSkill(userId, setId, name, revision) {
      return d.sql.begin(async (t) => {
        const tx = t as unknown as Db;
        await setFor(tx, userId, setId, revision);
        const done = (await tx`delete from app.skill_set_items where set_id = ${setId} and name = ${name} returning name`) as unknown[];
        if (done.length === 0) throw httpError(404, 'skill_not_found');
        return { revision: await bump(tx, setId) };
      }) as Promise<{ revision: number }>;
    },

    async forAgent(userId, agentId) {
      const cur = await activeOf(d.sql, userId, agentId);
      const approvals = await approvalsOf(d.sql, agentId);
      const sets = (await d.sql`select s.id, s.name, s.revision, a.revision as applied from app.skill_sets s
                                left join app.agent_skill_sets a on a.set_id = s.id and a.agent_id = ${agentId}
                                where s.user_id = ${userId} order by s.created_at, s.name`) as { id: string; name: string; revision: number; applied: number | null }[];
      const items = sets.length === 0 ? [] : ((await d.sql`select i.set_id, i.name, i.skill_id, i.content_hash, i.pin, i.verdict, i.audits, i.findings, i.accept_risk, i.description, i.body, i.added_at
                                                            from app.skill_set_items i join app.skill_sets s on s.id = i.set_id
                                                            where s.user_id = ${userId} order by i.added_at, i.name`) as (ItemRow & { set_id: string })[]);
      return {
        version: cur.version,
        sets: sets.map((s) => {
          const plan = planSet(cur.spec, approvals, items.filter((i) => i.set_id === s.id).map(asItem));
          return { id: s.id, name: s.name, revision: s.revision, applied: s.applied, add: plan.add.map((i) => i.name), update: plan.update.map((i) => i.name), same: plan.same, conflicts: plan.conflicts, fits: plan.fits };
        }),
      };
    },

    async apply(userId, agentId, setId, a) {
      return retrying(() =>
        d.sql.begin(async (t) => {
          const tx = t as unknown as Db;
          const cur = await activeOf(tx, userId, agentId, true);
          if (cur.version !== a.version) throw httpError(409, 'version_changed');
          const set = await setFor(tx, userId, setId, a.revision);
          const plan = planSet(cur.spec, await approvalsOf(tx, agentId), set.items);
          const no = refusal(plan);
          if (no) throw no;
          const items = [...plan.add, ...plan.update];
          const at = now();
          // Nothing new: the agent already holds the set as it is. Remember that it took this revision; no new version.
          const version = items.length === 0 ? cur.version : await saveApproved(tx, agentId, cur, withSet(cur.spec, plan), at);
          await recordSet(tx, { agentId, userId, setId, revision: set.revision, items, version, at });
          return { version, added: plan.add.map((i) => i.name), updated: plan.update.map((i) => i.name) };
        }) as Promise<{ version: number; added: string[]; updated: string[] }>,
      );
    },
  };
}
