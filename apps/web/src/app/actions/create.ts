'use server';
import { apiCall } from '@/server/api';
import { createCreateActions } from '@/server/create-actions';
import { accessToken } from '@/server/session';

const actions = () => createCreateActions({ api: apiCall, token: accessToken });

export async function meAction() {
  return actions().me();
}
export async function passkeyOptionsAction() {
  return actions().passkeyOptions();
}
export async function passkeyRegisterAction(response: unknown) {
  return actions().passkeyRegister(response);
}
export async function walletAction() {
  return actions().wallet();
}
export async function createAgentAction(input: { name: string; spec: unknown; view: unknown; key?: string; skillSet?: { id: string; revision: number } }) {
  return actions().createAgent(input);
}
export async function agentAction(id: string) {
  return actions().agent(id);
}
export async function retryAction(id: string) {
  return actions().retry(id);
}
export async function signRequestsAction() {
  return actions().signRequests();
}
export async function signAction(id: string, signedEntryXdr: string) {
  return actions().sign(id, signedEntryXdr);
}
export async function rejectAction(id: string) {
  return actions().reject(id);
}
