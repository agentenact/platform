// Fresh sponsor + agent + passkey smart wallet (C-address) on testnet. Prints public data only.
import { Keypair } from '@stellar/stellar-sdk';
import { SmartAccountKit, MemoryStorage } from 'smart-account-kit';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { ACCOUNT_WASM, ORIGIN, PASSPHRASE, RP_ID, RPC_URL, WEBAUTHN_VERIFIER, friendbot, loadState, saveState, softAuthenticator } from './lib';

const st = loadState();
if (!st.sponsorSecret) { st.sponsorSecret = Keypair.random().secret(); st.agentSecret = Keypair.random().secret(); saveState(st); }
const sponsor = Keypair.fromSecret(st.sponsorSecret), agent = Keypair.fromSecret(st.agentSecret);
console.log('sponsor', sponsor.publicKey(), '\nagent  ', agent.publicKey());
await friendbot(sponsor.publicKey());

const auth = softAuthenticator();
const storage = new MemoryStorage();
const kit = new SmartAccountKit({
  rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE, accountWasmHash: ACCOUNT_WASM,
  webauthnVerifierAddress: WEBAUTHN_VERIFIER, rpId: RP_ID, allowedOrigins: [ORIGIN],
  storage, webAuthn: auth.webAuthn as any,
  deployerSecret: st.sponsorSecret, indexerUrl: false,
} as any);
const res: any = await kit.createWallet('spike', 'spike@example.com', { autoSubmit: true });
console.log('createWallet success:', res.submitResult?.success, 'tx', res.submitResult?.hash, res.submitResult?.error?.message);
console.log('contractId', res.contractId);
st.contractId = res.contractId; st.credentialId = res.credentialId; st.privatePem = auth.privatePem; st.deployTx = res.submitResult?.hash; st.storedCredential = await storage.get(res.credentialId);
saveState(st);
