'use server';
import { revalidatePath } from 'next/cache';
import { apiCall } from '@/server/api';
import { createSkillActions, type ApproveSkill } from '@/server/skills-actions';
import { accessToken } from '@/server/session';

const actions = () => createSkillActions({ api: apiCall, token: accessToken });

/** Skills matching what the agent does; `query` is the owner's own words, optional. */
export async function suggestSkillsAction(agentId: string, query?: string) {
  return actions().suggest(agentId, query);
}

/** Skills on skills.sh for no agent in particular. */
export async function searchSkillsAction(query?: string) {
  return actions().search(query);
}

/** One skill's checks and instructions, at the commit the api read. */
export async function reviewSkillAction(id: string) {
  return actions().review(id);
}

/** Adds exactly the files the owner reviewed. */
export async function approveSkillAction(agentId: string, a: ApproveSkill) {
  const out = await actions().approve(agentId, a);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

export async function removeSkillAction(agentId: string, name: string, version: number) {
  const out = await actions().remove(agentId, name, version);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** The skills one paid offer runs with; its proofs then name them. */
export async function setOfferSkillsAction(agentId: string, slug: string, names: string[], version: number) {
  const out = await actions().setOfferSkills(agentId, slug, names, version);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}
