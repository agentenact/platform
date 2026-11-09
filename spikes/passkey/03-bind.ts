import { Address, Keypair, authorizeEntry, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { PASSPHRASE, connectKit, friendbot, invokeSponsored, loadState, saveState } from './lib';

const st = loadState();
const sponsor = Keypair.fromSecret(st.sponsorSecret), agent = Keypair.fromSecret(st.agentSecret);
await friendbot(agent.publicKey()); // agent account must exist for its auth entry to verify
const { kit, auth } = await connectKit(st);
const r = await invokeSponsored({
  sponsor, fn: 'set_agent_wallet',
  args: [Address.fromString(st.contractId).toScVal(), nativeToScVal(st.agentId, { type: 'u32' }), Address.fromString(agent.publicKey()).toScVal()],
  signEntry: async (e, validUntil) => {
    const a = Address.fromScAddress(e.credentials().address().address()).toString();
    if (a === st.contractId) return kit.signAuthEntry(e, { contextRuleIds: [0], expiration: validUntil } as any);
    if (a === agent.publicKey()) return authorizeEntry(e, agent, validUntil, PASSPHRASE);
    return null;
  },
});
console.log({ ...r, ret: r.ret ? scValToNative(r.ret) : null, assertions: auth.log.length });
if (r.status === 'SUCCESS') { st.bindTx = r.hash; saveState(st); }
