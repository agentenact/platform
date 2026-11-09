// Same register+bind, but ALL tx building / simulation / assembly / agent signing uses the LIBRARY's stellar-sdk 15.1;
// only the passkey auth-entry signing crosses to sdk 16 (smart-account-kit), exchanged as base64 XDR strings.
import * as S15 from '/Users/knrs/Developer/PROJECTS/agentenact/node_modules/@stellar/stellar-sdk/lib/index.js';
import { xdr as x16, Keypair as K16 } from '@stellar/stellar-sdk';
import { PASSPHRASE, REGISTRY, RPC_URL, connectKit, friendbot, loadState, saveState } from './lib';
const { Address, BASE_FEE, Operation, TransactionBuilder, nativeToScVal, rpc, xdr, authorizeEntry, Keypair, scValToNative } = S15 as any;
console.log('library sdk:', JSON.parse(await Bun.file('/Users/knrs/Developer/PROJECTS/agentenact/node_modules/@stellar/stellar-sdk/package.json').text()).version);

const st = loadState();
const sponsor = Keypair.fromSecret(st.sponsorSecret);
const agent2 = Keypair.random(); st.agent2Secret = agent2.secret(); saveState(st);
await friendbot(agent2.publicKey());
const server = new rpc.Server(RPC_URL);
const { kit } = await connectKit(st);
const c16 = async (e15: any, validUntil: number) => {
  const e16 = x16.SorobanAuthorizationEntry.fromXDR(e15.toXDR('base64'), 'base64');
  const out = await kit.signAuthEntry(e16, { contextRuleIds: [0], expiration: validUntil } as any);
  return xdr.SorobanAuthorizationEntry.fromXDR(out.toXDR('base64'), 'base64');
};
async function call(fn: string, args: any[], signer: (e: any, v: number, addr: string) => Promise<any>) {
  const build = async (auth?: any[]) => new TransactionBuilder(await server.getAccount(sponsor.publicKey()), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: REGISTRY, function: fn, args, ...(auth ? { auth } : {}) })).setTimeout(120).build();
  const s1 = await server.simulateTransaction(await build());
  if (rpc.Api.isSimulationError(s1)) throw new Error(s1.error);
  const vu = s1.latestLedger + 200;
  const auth = await Promise.all(s1.result.auth.map((e: any) => signer(e, vu, Address.fromScAddress(e.credentials().address().address()).toString())));
  const s2 = await server.simulateTransaction(await build(auth));
  if (rpc.Api.isSimulationError(s2)) throw new Error('enforcing: ' + s2.error);
  const tx = rpc.assembleTransaction(await build(auth), s2).build(); tx.sign(sponsor);
  const sent = await server.sendTransaction(tx);
  const done = await server.pollTransaction(sent.hash, { attempts: 20 });
  return { hash: sent.hash, status: done.status, ret: done.returnValue ? scValToNative(done.returnValue) : null };
}
const C = Address.fromString(st.contractId).toScVal();
const reg = await call('register_with_uri', [C, nativeToScVal('https://agentenact.example/spike/agent2.json', { type: 'string' })], (e, v) => c16(e, v));
console.log('register', reg);
const bind = await call('set_agent_wallet', [C, nativeToScVal(reg.ret, { type: 'u32' }), Address.fromString(agent2.publicKey()).toScVal()],
  (e, v, a) => a === st.contractId ? c16(e, v) : a === agent2.publicKey() ? authorizeEntry(e, agent2, v, PASSPHRASE) : Promise.reject(new Error('unexpected signer ' + a)));
console.log('bind', bind);
st.sdk15 = { agentId: reg.ret, agent: agent2.publicKey(), registerTx: reg.hash, bindTx: bind.hash }; saveState(st);
