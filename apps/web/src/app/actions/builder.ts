'use server';
import { apiCall } from '@/server/api';
import { createBuilderActions } from '@/server/builder-actions';
import { accessToken } from '@/server/session';

const actions = () => createBuilderActions({ api: apiCall, token: accessToken });

export async function draftAction(prompt: string, current?: unknown) {
  return actions().draft(prompt, current);
}
export async function editAction(draft: unknown, param: string, value: unknown) {
  return actions().edit(draft, param, value);
}
export async function trialAction(spec: unknown) {
  return actions().trial(spec);
}
export async function handoffAction(draft: unknown, email?: string) {
  return actions().handoff(draft, email);
}
export async function templateAction(id: string) {
  return actions().template(id);
}
export async function claimAction(id: string) {
  return actions().claim(id);
}
