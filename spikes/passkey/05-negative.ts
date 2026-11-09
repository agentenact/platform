// Negative controls: prove __check_auth is really enforced (enforcing-mode simulation only, nothing submitted).
import { Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { connectKit, invokeSponsored, loadState, softAuthenticator } from './lib';
import { SmartAccountKit } from 'smart-account-kit';
const st = loadState();
const sponsor = Keypair.fromSecret(st.sponsorSecret);
const args = [Address.fromString(st.contractId).toScVal(), nativeToScVal('https://x.example/neg', { type: 'string' })];
const run = async (label: string, signEntry: any) => {
  try { const r = await invokeSponsored({ sponsor, fn: 'register_with_uri', args, signEntry }); console.log(label, '=> UNEXPECTED', r.status); }
  catch (e: any) { console.log(label, '=> rejected:', String(e.message).slice(0, 160)); }
};
// 1. unsigned entry
await run('unsigned entry      ', async () => null);
// 2. valid credential id, WRONG P-256 key
const { kit } = await connectKit(st);
const evil = softAuthenticator(undefined, st.credentialId);
(kit as any).webAuthn = evil.webAuthn;
await run('wrong passkey key   ', (e: any, v: number) => kit.signAuthEntry(e, { contextRuleIds: [0], expiration: v } as any));
