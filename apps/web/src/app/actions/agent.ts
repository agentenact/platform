'use server';
import { revalidatePath } from 'next/cache';
import { apiCall } from '@/server/api';
import { createAgentActions, type PauseOut, type RunNowOut } from '@/server/agent-actions';
import { loadRun } from '@/server/run-data';
import { accessToken } from '@/server/session';
import type { RunOut } from '@/lib/run-details';
import type { LiveRun, ModelChoice } from '@/lib/agent-types';

/** Pause (true) or resume (false) the signed-in owner's agent. On success the page is rendered again with the new status. */
export async function setPausedAction(agentId: string, paused: boolean): Promise<PauseOut> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).setPaused(agentId, paused);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** Run the signed-in owner's agent now. On a queued run the page is rendered again, so the header says "Checking now". */
export async function runNowAction(agentId: string): Promise<RunNowOut> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).runNow(agentId);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/**
 * What the owner's running agent is doing now, for the live panel. When the run is over (`idle`) the page is rendered
 * again, so the header, the numbers and the feed show the result without a reload.
 */
export async function liveRunAction(agentId: string): Promise<LiveRun | null> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).live(agentId);
  if (out?.phase === 'idle') revalidatePath('/dashboard', 'layout');
  return out;
}

/**
 * A paused agent's Run now: resume it, then run it now. Paused means "not checking, spending nothing" all the way down
 * (scheduler, spend policy, vault), so a run needs the agent active. A failed resume answers like a run that did not start.
 */
export async function resumeAndRunAction(agentId: string): Promise<RunNowOut> {
  const a = createAgentActions({ api: apiCall, token: accessToken });
  const resumed = await a.setPaused(agentId, false);
  if (!resumed.ok) return { ok: false, status: resumed.status, code: resumed.status === 409 ? 'not_resumed' : 'failed' };
  revalidatePath('/dashboard', 'layout');
  const out = await a.runNow(agentId);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** Delete the signed-in owner's agent. On success every dashboard page is rendered again without it. */
export async function deleteAgentAction(agentId: string): Promise<PauseOut> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).remove(agentId);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** Save the owner's yes or no to the morning note. On success the page is rendered again with the answer. */
export async function setMorningNoteAction(agentId: string, on: boolean): Promise<PauseOut> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).setMorningNote(agentId, on);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** Pick the model the signed-in owner's agent runs on (null = the default). On success the page shows the new model. */
export async function setModelAction(agentId: string, model: string | null): Promise<PauseOut> {
  const out = await createAgentActions({ api: apiCall, token: accessToken }).setModel(agentId, model);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}

/** The whole model list for the picker's "All models". Null on any failure. */
export async function listModelsAction(): Promise<ModelChoice[] | null> {
  return createAgentActions({ api: apiCall, token: accessToken }).models();
}

/** One run of the signed-in owner's own agent, for the expandable activity rows. Any failure is `{ ok: false }`. */
export async function loadRunAction(agentId: string, runId: string): Promise<RunOut> {
  return loadRun(agentId, runId);
}
