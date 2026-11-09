'use server';
import { revalidatePath } from 'next/cache';
import { apiCall } from '@/server/api';
import { createSellActions } from '@/server/sell-actions';
import { accessToken } from '@/server/session';

/** Offers the suggested thing to other agents. `version` is the one the card showed. */
export async function offerAction(agentId: string, version: number) {
  const out = await createSellActions({ api: apiCall, token: accessToken }).offer(agentId, version);
  if (out.ok) revalidatePath('/dashboard', 'layout');
  return out;
}
