/**
 * Skill sets as plain data: the api's answers read defensively. A set is a named bundle of skills from skills.sh on the
 * owner's account, each pinned at the version they approved; applying one gives an agent all of them in one step. Nothing
 * here decides anything: the server checks every pin, every revision and every agent version again.
 */
import type { SkillVerdict } from './skills';

export interface SetSkill {
  id: string;
  name: string;
  description: string;
  verdict: SkillVerdict;
  commit: string | null;
  addedAt: string;
}
export interface SkillSet {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  skills: SetSkill[];
}

export type SetConflict = { name: string; reason: 'name_taken' | 'edited' };
/** One set as one agent sees it: what applying it would do now. */
export interface AgentSet {
  id: string;
  name: string;
  revision: number;
  applied: number | null;
  add: string[];
  update: string[];
  same: string[];
  conflicts: SetConflict[];
  fits: boolean;
}
export interface AgentSets {
  version: number;
  sets: AgentSet[];
}

/** A skill the owner's agents hold as approved and unedited: pickable into a new set at this exact version. */
export interface ApprovedSkill {
  id: string;
  name: string;
  description: string;
  verdict: SkillVerdict;
  commit: string | null;
  contentHash: string;
  agents: string[];
}

/** The api's limits (api skills/sets.ts). */
export const MAX_SKILL_SETS = 20;
export const MAX_SET_SKILLS = 10;
export const SET_NAME_MAX = 60;

const VERDICTS: readonly string[] = ['clear', 'caution', 'blocked', 'unaudited'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

export const okSetId = (v: unknown): v is string => str(v) && UUID.test(v);

export function asSets(json: unknown): SkillSet[] | null {
  if (!isObj(json) || !Array.isArray(json.sets)) return null;
  const out: SkillSet[] = [];
  for (const s of json.sets) {
    if (!isObj(s) || !okSetId(s.id) || !str(s.name) || !count(s.revision) || !str(s.updatedAt) || !Array.isArray(s.skills)) return null;
    const skills: SetSkill[] = [];
    for (const k of s.skills) {
      if (!isObj(k) || !str(k.id) || !str(k.name) || !str(k.description) || !str(k.verdict) || !VERDICTS.includes(k.verdict) || !str(k.addedAt)) return null;
      if (k.commit !== null && !str(k.commit)) return null;
      skills.push({ id: k.id, name: k.name, description: k.description, verdict: k.verdict as SkillVerdict, commit: k.commit, addedAt: k.addedAt });
    }
    out.push({ id: s.id, name: s.name, revision: s.revision, updatedAt: s.updatedAt, skills });
  }
  return out;
}

export function asApproved(json: unknown): ApprovedSkill[] | null {
  if (!isObj(json) || !Array.isArray(json.skills)) return null;
  const out: ApprovedSkill[] = [];
  for (const k of json.skills) {
    if (!isObj(k) || !str(k.id) || !str(k.name) || !str(k.description) || !str(k.verdict) || !VERDICTS.includes(k.verdict) || !str(k.contentHash) || !strings(k.agents)) return null;
    if (k.commit !== null && !str(k.commit)) return null;
    out.push({ id: k.id, name: k.name, description: k.description, verdict: k.verdict as SkillVerdict, commit: k.commit, contentHash: k.contentHash, agents: k.agents });
  }
  return out;
}

/** The picks after toggling one skill. A set holds one skill per name, so picking one drops another source of that name. */
export function toggledPicks(skills: readonly { id: string; name: string }[], picks: readonly string[], id: string): string[] {
  if (picks.includes(id)) return picks.filter((p) => p !== id);
  const name = skills.find((k) => k.id === id)?.name;
  return [...picks.filter((p) => skills.find((k) => k.id === p)?.name !== name), id];
}

export function asAgentSets(json: unknown): AgentSets | null {
  if (!isObj(json) || !count(json.version) || !Array.isArray(json.sets)) return null;
  const sets: AgentSet[] = [];
  for (const s of json.sets) {
    if (!isObj(s) || !okSetId(s.id) || !str(s.name) || !count(s.revision) || !(s.applied === null || count(s.applied))) return null;
    if (!strings(s.add) || !strings(s.update) || !strings(s.same) || typeof s.fits !== 'boolean' || !Array.isArray(s.conflicts)) return null;
    const conflicts: SetConflict[] = [];
    for (const c of s.conflicts) {
      if (!isObj(c) || !str(c.name) || (c.reason !== 'name_taken' && c.reason !== 'edited')) return null;
      conflicts.push({ name: c.name, reason: c.reason });
    }
    sets.push({ id: s.id, name: s.name, revision: s.revision, applied: s.applied, add: s.add, update: s.update, same: s.same, conflicts, fits: s.fits });
  }
  return { version: json.version, sets };
}

/**
 * Where one set stands for one agent. `ready`: applying adds or moves something. `current`: the agent holds it as it is.
 * `blocked`: applying would be refused (a name taken, a hand edit, too many skills). `empty`: the set holds nothing.
 * `changed` says the set moved on since this agent last took it.
 */
export function setStanding(s: AgentSet): { state: 'ready' | 'current' | 'blocked' | 'empty'; changed: boolean } {
  const changed = s.applied !== null && s.applied < s.revision;
  if (s.conflicts.length > 0 || !s.fits) return { state: 'blocked', changed };
  if (s.add.length + s.update.length > 0) return { state: 'ready', changed };
  if (s.same.length === 0) return { state: 'empty', changed };
  return { state: 'current', changed };
}
