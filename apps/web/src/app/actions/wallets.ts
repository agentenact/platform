'use server';
import { apiCall } from '@/server/api';
import { accessToken } from '@/server/session';
import { createWalletActions } from '@/server/wallets-actions';

/** Has the vault make the agent's wallet on an EVM testnet; the same address after. */
export async function openWalletAction(agentId: string, network: string) {
  return createWalletActions({ api: apiCall, token: accessToken }).open(agentId, network);
}
