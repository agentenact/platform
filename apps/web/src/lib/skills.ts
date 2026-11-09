/**
 * Skills from skills.sh, as plain data: the api's answers read defensively, the "Not now" memory of the prompt card, and
 * which reviews need the owner's extra tick. The server decides everything; nothing here is shown as done ahead of it.
 */

export type SkillVerdict = 'clear' | 'caution' | 'blocked' | 'unaudited';
export type SkillFindingCode = 'executable' | 'secret_reference' | 'network' | 'broad_tools';

export interface SkillHeld {
  name: string;
  description: string;
  /** Null for a skill written for this agent (by the builder or by hand). */
  source: null | { id: string; verdict: SkillVerdict; approvedAt: string; commit: string | null; edited: boolean };
}
/** One thing other agents pay for (a paid service), and the skills it runs with. */
export interface PaidOffer {
  slug: string;
  description: string;
  skills: string[];
}
export interface SkillsHeld {
  version: number;
  skills: SkillHeld[];
  offers: PaidOffer[];
}

/** Skills one paid offer may run with (the api's MAX_SERVICE_SKILLS). */
export const MAX_OFFER_SKILLS = 2;

export interface SkillSuggested {
  id: string;
  name: string;
  source: string;
  installs: number;
  url: string;
  matched: string[];
}
export interface SkillSuggestions {
  version: number;
  queries: string[];
  suggestions: SkillSuggested[];
}

export interface SkillAuditShown {
  provider: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  riskLevel?: string;
  summary: string;
  auditedAt: string;
}
export interface SkillReviewShown {
  id: string;
  name: string;
  description: string;
  verdict: SkillVerdict;
  audits: SkillAuditShown[];
  findings: { code: SkillFindingCode; path: string; detail: string }[];
  commit: string;
  contentHash: string;
  instructions: string;
  unused: string[];
  fits: boolean;
}

const VERDICTS: readonly string[] = ['clear', 'caution', 'blocked', 'unaudited'];
const FINDINGS: readonly string[] = ['executable', 'secret_reference', 'network', 'broad_tools'];
const AUDIT_STATUS: readonly string[] = ['pass', 'warn', 'fail', 'unknown'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const okVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

/** A blocked or unaudited skill is added only with the owner's explicit "I have read the checks". */
export const needsRisk = (v: SkillVerdict): boolean => v === 'blocked' || v === 'unaudited';

export function asHeld(json: unknown): SkillsHeld | null {
  if (!isObj(json) || !okVersion(json.version) || !Array.isArray(json.skills)) return null;
  const skills: SkillHeld[] = [];
  for (const s of json.skills) {
    if (!isObj(s) || !str(s.name) || !str(s.description)) return null;
    const src = s.source;
    if (src === null) {
      skills.push({ name: s.name, description: s.description, source: null });
      continue;
    }
    if (!isObj(src) || !str(src.id) || !str(src.verdict) || !VERDICTS.includes(src.verdict) || !str(src.approvedAt) || typeof src.edited !== 'boolean') return null;
    if (src.commit !== null && !str(src.commit)) return null;
    skills.push({
      name: s.name,
      description: s.description,
      source: { id: src.id, verdict: src.verdict as SkillVerdict, approvedAt: src.approvedAt, commit: src.commit, edited: src.edited },
    });
  }
  const offers: PaidOffer[] = [];
  for (const o of Array.isArray(json.services) ? json.services : []) {
    if (!isObj(o) || !str(o.slug) || !str(o.description) || !strings(o.skills)) return null;
    offers.push({ slug: o.slug, description: o.description, skills: o.skills });
  }
  return { version: json.version, skills, offers };
}

/** The offer's skills with `name` switched on or off; null when switching on would pass the limit. */
export function toggledSkills(offer: PaidOffer, name: string, on: boolean): string[] | null {
  if (!on) return offer.skills.filter((n) => n !== name);
  if (offer.skills.includes(name)) return offer.skills;
  return offer.skills.length >= MAX_OFFER_SKILLS ? null : [...offer.skills, name];
}

/** The skills in a search's answer (`/api/skills/search` and an agent's suggestions). */
export function asSuggested(list: unknown): SkillSuggested[] | null {
  if (!Array.isArray(list)) return null;
  const suggestions: SkillSuggested[] = [];
  for (const s of list) {
    if (!isObj(s) || !str(s.id) || !str(s.name) || !str(s.source) || typeof s.installs !== 'number' || !str(s.url) || !strings(s.matched)) return null;
    // Only skills.sh's own pages are linked.
    const url = /^https:\/\/skills\.sh\//.test(s.url) ? s.url : `https://skills.sh/${s.id}`;
    suggestions.push({ id: s.id, name: s.name, source: s.source, installs: s.installs, url, matched: s.matched });
  }
  return suggestions;
}

export function asSuggestions(json: unknown): SkillSuggestions | null {
  if (!isObj(json) || !okVersion(json.version) || !strings(json.queries)) return null;
  const suggestions = asSuggested(json.suggestions);
  return suggestions && { version: json.version, queries: json.queries, suggestions };
}

export function asReview(json: unknown): SkillReviewShown | null {
  const j = json;
  if (!isObj(j) || !str(j.id) || !str(j.name) || !str(j.description) || !str(j.verdict) || !VERDICTS.includes(j.verdict)) return null;
  if (!str(j.commit) || !str(j.contentHash) || !str(j.instructions) || !strings(j.unused) || typeof j.fits !== 'boolean') return null;
  if (!Array.isArray(j.audits) || !Array.isArray(j.findings)) return null;
  const audits: SkillAuditShown[] = [];
  for (const a of j.audits) {
    if (!isObj(a) || !str(a.provider) || !str(a.status) || !AUDIT_STATUS.includes(a.status) || !str(a.summary) || !str(a.auditedAt)) return null;
    audits.push({ provider: a.provider, status: a.status as SkillAuditShown['status'], summary: a.summary, auditedAt: a.auditedAt, ...(str(a.riskLevel) ? { riskLevel: a.riskLevel } : {}) });
  }
  const findings: SkillReviewShown['findings'] = [];
  for (const f of j.findings) {
    if (!isObj(f) || !str(f.code) || !FINDINGS.includes(f.code) || !str(f.path) || !str(f.detail)) return null;
    findings.push({ code: f.code as SkillFindingCode, path: f.path, detail: f.detail });
  }
  return {
    id: j.id,
    name: j.name,
    description: j.description,
    verdict: j.verdict as SkillVerdict,
    audits,
    findings,
    commit: j.commit,
    contentHash: j.contentHash,
    instructions: j.instructions,
    unused: j.unused,
    fits: j.fits,
  };
}

/** What the server actions answer. A failure carries one plain sentence, never a body. */
export type SkillOut<T> = { ok: true; data: T } | { ok: false; message: string };

// --- the prompt card on the agent page --------------------------------------------------------------

export const SKILLS_HIDE_DAYS = 7;
const DAY_MS = 86_400_000;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export const skillsHideKey = (agentId: string) => `agentenact.skills.notnow.${agentId}`;

/** True while a "Not now" from the last 7 days stands. Without storage (or with a broken value) the card simply shows. */
export function skillsHiddenNow(store: Store | null, agentId: string, now: number): boolean {
  try {
    const until = Number(store?.getItem(skillsHideKey(agentId)));
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/** Remembers "Not now" for 7 days. Never throws. */
export function hideSkillsForAWeek(store: Store | null, agentId: string, now: number): void {
  try {
    store?.setItem(skillsHideKey(agentId), String(now + SKILLS_HIDE_DAYS * DAY_MS));
  } catch {
    /* private window, blocked or full storage */
  }
}

/** The card shows only while the agent holds no skill from skills.sh: once the owner has picked one, it has done its job. */
export const showSkillsCard = (held: SkillsHeld | null): boolean => held !== null && !held.skills.some((s) => s.source !== null);
