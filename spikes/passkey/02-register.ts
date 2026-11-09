import { Address, Keypair, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { connectKit, invokeSponsored, loadState, saveState } from './lib';

const st = loadState();
const sponsor = Keypair.fromSecret(st.sponsorSecret);
const { kit, auth, connected } = await connectKit(st);
console.log('connected', !!connected, st.contractId);
const uri = 'https://agentenact.example/spike/agent.json';
const r = await invokeSponsored({
  sponsor, fn: 'register_with_uri',
  args: [Address.fromString(st.contractId).toScVal(), nativeToScVal(uri, { type: 'string' })],
  signEntry: (e, validUntil) => kit.signAuthEntry(e, { contextRuleIds: [0], expiration: validUntil } as any),
});
console.log({ ...r, ret: r.ret ? scValToNative(r.ret) : null, assertions: auth.log.length });
if (r.status === 'SUCCESS') { st.agentId = Number(scValToNative(r.ret!)); st.registerTx = r.hash; saveState(st); }
