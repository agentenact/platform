'use server';
import { revalidatePath } from 'next/cache';
import { apiCall } from '@/server/api';
import { accessToken } from '@/server/session';
import { createTokenActions, type IssueOut, type RevokeOut } from '@/server/token-actions';

const actions = () => createTokenActions({ api: apiCall, token: accessToken });

/** Makes a token for a harness. The token is in this answer only; the page shows it once and never stores it. */
export async function issueTokenAction(name: string): Promise<IssueOut> {
  const out = await actions().issue(name);
  if (out.ok) revalidatePath('/connect');
  return out;
}

export async function revokeTokenAction(id: string): Promise<RevokeOut> {
  const out = await actions().revoke(id);
  if (out.ok) revalidatePath('/connect');
  return out;
}
