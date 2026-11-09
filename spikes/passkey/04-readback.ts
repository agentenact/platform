import { createStellarAdapter } from '/Users/knrs/Developer/PROJECTS/agentenact/src/adapters/stellar.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { loadState } from './lib';
const st = loadState();
const agent = Keypair.fromSecret(st.agentSecret).publicKey();
const a = createStellarAdapter({ network: 'testnet' } as any);
const id = await a.resolveIdentity(String(st.agentId));
console.log('agentId', st.agentId, id);
console.log('owner == C-address:', id?.owner === st.contractId, '| wallet == agent G:', id?.wallet === agent);
