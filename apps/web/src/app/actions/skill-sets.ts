'use server';
import { revalidatePath } from 'next/cache';
import { apiCall } from '@/server/api';
import { createSkillSetActions, type AddToSet, type SetPick } from '@/server/skill-sets-actions';
import { accessToken } from '@/server/session';

const actions = () => createSkillSetActions({ api: apiCall, token: accessToken });
const fresh = <T extends { ok: boolean }>(out: T): T => {
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
};

export async function listSkillSetsAction() {
  return actions().list();
}

/** A new set; `fromAgent` copies that agent's approved skills from skills.sh. */
export async function createSkillSetAction(name: string, fromAgent?: string) {
  return fresh(await actions().create(name, fromAgent));
}

/** What can be picked into a new set: the owner's agents' approved, unedited skills. */
export async function approvedSkillsAction() {
  return actions().approved();
}

export async function createSkillSetWithAction(name: string, picks: SetPick[]) {
  return fresh(await actions().createWith(name, picks));
}

export async function renameSkillSetAction(setId: string, name: string) {
  return fresh(await actions().rename(setId, name));
}

/** Agents keep the skills they took from it. */
export async function removeSkillSetAction(setId: string) {
  return fresh(await actions().remove(setId));
}

/** Adds exactly the files the owner reviewed to one of their sets. */
export async function addToSkillSetAction(setId: string, a: AddToSet) {
  return fresh(await actions().addSkill(setId, a));
}

export async function removeFromSkillSetAction(setId: string, name: string, revision: number) {
  return fresh(await actions().removeSkill(setId, name, revision));
}

export async function agentSkillSetsAction(agentId: string) {
  return actions().forAgent(agentId);
}

export async function applySkillSetAction(agentId: string, setId: string, a: { version: number; revision: number }) {
  return fresh(await actions().apply(agentId, setId, a));
}
