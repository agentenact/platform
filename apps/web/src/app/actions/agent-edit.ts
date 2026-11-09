'use server';
import { revalidatePath } from 'next/cache';
import { okZone, reschedule, type RescheduleOut } from '@/lib/reschedule';
import { apiCall } from '@/server/api';
import { createAgentEditActions } from '@/server/agent-edit-actions';
import { accessToken } from '@/server/session';

const actions = () => createAgentEditActions({ api: apiCall, token: accessToken });

export async function tapAction(agentId: string, param: string, value: string | number | boolean, earlier: { param: string; value: string | number | boolean }[]) {
  return actions().edit(agentId, param, value, earlier);
}
export async function saveAction(agentId: string, draft: unknown) {
  return actions().save(agentId, draft as never);
}
export async function reviseAction(agentId: string, prompt: string) {
  return actions().revise(agentId, prompt);
}
export async function approveAction(agentId: string, version: number, createdAt?: string) {
  return actions().approve(agentId, version, createdAt);
}
export async function discardAction(agentId: string, version: number) {
  return actions().discard(agentId, version);
}

/** Reschedule from the header: the new time is stored and approved in one go; on success the page is rendered again. */
export async function rescheduleAction(agentId: string, param: string, value: string, tz: string | undefined): Promise<RescheduleOut> {
  const a = actions();
  const out = await reschedule({ tap: (p, v) => a.edit(agentId, p, v, []), save: (d) => a.save(agentId, d) }, param, value, okZone(tz));
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}
