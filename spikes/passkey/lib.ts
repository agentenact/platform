// Shared helpers for the passkey spike. TESTNET ONLY.
import { createHash, generateKeyPairSync, randomBytes, sign as edsign, type KeyObject } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const PASSPHRASE = 'Test SDF Network ; September 2015';
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON = 'https://horizon-testnet.stellar.org';
export const REGISTRY = 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH';
// OpenZeppelin/stellar-contracts multisig-account-example, uploaded on testnet (smart-account-kit 0.8.0 demo/.env.example)
export const ACCOUNT_WASM = '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a';
export const WEBAUTHN_VERIFIER = 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F';
export const RP_ID = 'spike.localhost';
export const ORIGIN = 'https://spike.localhost';
export const STATE = new URL('./.spike-state.json', import.meta.url).pathname;

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | Uint8Array | string) => createHash('sha256').update(b).digest();

export type State = Record<string, any>;
export const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
export const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });

export async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!r.ok && !(await r.text()).includes('already')) throw new Error(`friendbot ${r.status}`);
}

/** Software P-256 "authenticator" producing real WebAuthn-format registration/assertion JSON. */
export function softAuthenticator(key?: { priv: KeyObject; pub: KeyObject }, credentialId?: string) {
  const exportPriv = () => '';
  const kp: any = key ? { privateKey: key.priv, publicKey: key.pub } : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = kp.privateKey as KeyObject;
  const pub = kp.publicKey as KeyObject;
  const credId = credentialId ? Buffer.from(credentialId, 'base64url') : randomBytes(32);
  let counter = 1;
  const spki = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  const log: { kind: string; challenge: string }[] = [];
  return {
    credentialId: b64u(credId),
    privatePem: priv.export({ type: 'pkcs8', format: 'pem' }) as string,
    log,
    webAuthn: {
      async startRegistration({ optionsJSON }: any) {
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: optionsJSON.challenge, origin: ORIGIN }));
        return {
          id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
          response: {
            clientDataJSON: b64u(clientData),
            attestationObject: b64u(Buffer.from('software-authenticator-no-attestation')),
            publicKey: b64u(spki), transports: ['internal'], publicKeyAlgorithm: -7,
          },
        };
      },
      async startAuthentication({ optionsJSON }: any) {
        log.push({ kind: 'assertion', challenge: optionsJSON.challenge });
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: false }));
        const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter++);
        const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]) /* UP|UV */, cnt]);
        const sig = edsign('sha256', Buffer.concat([authData, sha256(clientData)]), priv); // DER
        return {
          id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
          response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) },
        };
      },
    },
  };
}

import { Address, BASE_FEE, Operation, TransactionBuilder, nativeToScVal, rpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { SmartAccountKit, MemoryStorage } from 'smart-account-kit';
import { createPrivateKey, createPublicKey } from 'node:crypto';

export const server = new rpc.Server(RPC_URL);

export async function connectKit(st: State) {
  const priv = createPrivateKey(st.privatePem);
  const auth = softAuthenticator({ priv, pub: createPublicKey(priv) }, st.credentialId);
  const storage = new MemoryStorage();
  if (st.storedCredential) {
    const sc = { ...st.storedCredential };
    if (sc.publicKey && !(sc.publicKey instanceof Uint8Array)) sc.publicKey = Uint8Array.from(Object.values(sc.publicKey) as number[]);
    await storage.save(sc);
  }
  const kit = new SmartAccountKit({
    rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE, accountWasmHash: ACCOUNT_WASM,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER, rpId: RP_ID, allowedOrigins: [ORIGIN],
    storage, webAuthn: auth.webAuthn as any,
    deployerSecret: st.sponsorSecret, indexerUrl: false,
  } as any);
  const c = await kit.connectWallet({ credentialId: st.credentialId, contractId: st.contractId });
  return { kit, auth, connected: c };
}

/**
 * Invoke `fn` on the registry with `sponsor` as tx source/fee payer. Auth entries for `signers`
 * (C-address via kit, G-address via keypair) are signed, then the tx is RE-SIMULATED with the signed
 * entries (enforcing mode: __check_auth really runs), assembled, and submitted.
 */
export async function invokeSponsored(opts: {
  sponsor: import('@stellar/stellar-sdk').Keypair; fn: string; args: xdr.ScVal[];
  signEntry: (e: xdr.SorobanAuthorizationEntry, validUntil: number) => Promise<xdr.SorobanAuthorizationEntry | null>;
}) {
  const build = async (auth?: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(await server.getAccount(opts.sponsor.publicKey()), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.invokeContractFunction({ contract: REGISTRY, function: opts.fn, args: opts.args, ...(auth ? { auth } : {}) }))
      .setTimeout(120).build();
  const sim1 = await server.simulateTransaction(await build());
  if (rpc.Api.isSimulationError(sim1)) throw new Error('recording sim: ' + sim1.error);
  const validUntil = sim1.latestLedger + 200;
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  const kinds: string[] = [];
  for (const e of sim1.result!.auth) {
    const c = e.credentials();
    if (c.switch().name === 'sorobanCredentialsSourceAccount') { signed.push(e); kinds.push('source-account'); continue; }
    const addr = Address.fromScAddress(c.address().address()).toString();
    const out = await opts.signEntry(e, validUntil);
    kinds.push(`${addr[0] === 'C' ? 'contract' : 'account'}:${addr.slice(0, 6)}${out ? '(signed)' : '(UNSIGNED)'}`);
    signed.push(out ?? e);
  }
  const sim2 = await server.simulateTransaction(await build(signed)); // enforcing: runs __check_auth
  if (rpc.Api.isSimulationError(sim2)) throw new Error('enforcing sim: ' + sim2.error);
  const prepared = rpc.assembleTransaction(await build(signed), sim2).build();
  prepared.sign(opts.sponsor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error('send: ' + sent.errorResult?.toXDR('base64'));
  const done = await server.pollTransaction(sent.hash, { attempts: 20 });
  return { hash: sent.hash, status: done.status, ret: (done as any).returnValue as xdr.ScVal | undefined, kinds, validUntil, latest: sim1.latestLedger, fee: prepared.fee, resultXdr: (done as any).resultXdr?.toXDR?.('base64') };
}
