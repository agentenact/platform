/**
 * Server-side wallet deploy (plan D7). The browser ran the WebAuthn ceremony; the account unit
 * verified clientDataJSON. The kit gets that response through an injected startRegistration and
 * our sponsor as deployer, so the C address derives from our deployer, never the kit's shared one.
 *
 * The kit wants the deployer's raw secret; the sponsor key lives in the vault, so the kit gets a throwaway one
 * and then our deployer in its place: the sponsor's public key (it derives the address and sources the tx) and a
 * signWithDeployer that asks the sponsor signer. Both are kit internals (pinned smart-account-kit 0.8.0); if
 * they are not where we expect, the deploy fails before anything is built.
 */
import { Keypair } from '@stellar/stellar-sdk';
import type { StellarSigner } from 'agentenact/create';
import { MemoryStorage, SmartAccountKit, type SmartAccountConfig } from 'smart-account-kit';
import { serializeCredential, type SerializedCredential } from '../owner-client/credential.js';
import { TESTNET } from '../owner-client/testnet.js';
import type { RegistrationResponse } from '../owner-client/types.js';

export interface DeployedWallet {
  contractId: string;
  credentialId: string;
  credential: SerializedCredential;
  deployTx: string;
}

export interface WalletKit {
  createWallet(
    appName: string,
    userName: string,
    options: { autoSubmit: boolean },
  ): Promise<{ credentialId: string; contractId: string; submitResult?: { success: boolean; hash?: string; error?: { code?: string } } }>;
}

export type KitFactory = (config: SmartAccountConfig) => WalletKit;

export const defaultKitFactory: KitFactory = (config) => new SmartAccountKit(config) as unknown as WalletKit;

/** What the kit holds about its deployer; replaced by `useDeployer`. */
interface KitDeployerSlots {
  deployerKeypair?: { publicKey?: unknown };
  usingSharedDeployer?: boolean;
  signWithDeployer?: unknown;
  readonly deployerPublicKey?: string;
}

/** Puts `deployer` in the kit's deployer slots. Throws if the kit does not have them. */
export function useDeployer(kit: WalletKit, deployer: StellarSigner): void {
  const k = kit as unknown as KitDeployerSlots;
  if (typeof k.deployerKeypair?.publicKey !== 'function' || typeof k.signWithDeployer !== 'function' || typeof k.usingSharedDeployer !== 'boolean') {
    throw Object.assign(new Error('chain: smart-account-kit has no deployer slots'), { code: 'kit_unsupported' });
  }
  // Public key only: any signature the kit tried to make with it directly would throw.
  k.deployerKeypair = Keypair.fromPublicKey(deployer.publicKey);
  k.usingSharedDeployer = false;
  k.signWithDeployer = async (tx: { sign(o: { signTransaction: (x: string) => Promise<{ signedTxXdr: string; signerAddress: string }> }): Promise<void> }) =>
    tx.sign({ signTransaction: async (x) => ({ signedTxXdr: await deployer.signTransaction(x, TESTNET.passphrase), signerAddress: deployer.publicKey }) });
  if (k.deployerPublicKey !== undefined && k.deployerPublicKey !== deployer.publicKey) {
    throw Object.assign(new Error('chain: smart-account-kit kept its own deployer'), { code: 'kit_unsupported' });
  }
}

export async function deployWithKit(o: {
  deployer: StellarSigner;
  rpId: string;
  origin: string;
  /** Extra accepted origins; the kit gets `origin` plus these. */
  origins?: readonly string[];
  response: RegistrationResponse;
  userName: string;
  createKit: KitFactory;
}): Promise<DeployedWallet> {
  const storage = new MemoryStorage();
  const config = {
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.passphrase,
    accountWasmHash: TESTNET.accountWasmHash,
    webauthnVerifierAddress: TESTNET.webauthnVerifier,
    rpId: o.rpId,
    // The kit reads allowedOrigins only in connectWallet's fresh-assertion check (kit.js connectWithCredentials ->
    // wallet-provenance.js verifyFreshAssertion), which this server-side deploy never reaches: createWallet ignores it
    // and the origin is not part of the wallet (its signer is verifier address + public key + credential id). It gets
    // the same list the account unit accepts at registration, so the two never disagree.
    allowedOrigins: [...new Set([o.origin, ...(o.origins ?? [])])],
    storage,
    // Throwaway: replaced by useDeployer before the kit builds anything.
    deployerSecret: Keypair.random().secret(),
    indexerUrl: false,
    webAuthn: {
      startRegistration: async () => o.response as never,
      startAuthentication: async () => {
        throw new Error('chain: the server never asks for a passkey assertion');
      },
    },
  } as unknown as SmartAccountConfig;
  let res: Awaited<ReturnType<WalletKit['createWallet']>>;
  try {
    const kit = o.createKit(config);
    useDeployer(kit, o.deployer);
    res = await kit.createWallet('AgentEnact', o.userName, { autoSubmit: true });
  } catch (e) {
    // A kit throw keeps only its code (a fixed word): its message may carry RPC detail.
    const code = (e as { code?: unknown } | null)?.code;
    throw new Error(`chain: wallet deploy failed: ${typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'kit_error'}`);
  }
  const submit = res.submitResult;
  if (!submit?.success || !submit.hash) {
    const where = submit?.hash ? ` (tx ${submit.hash})` : '';
    throw new Error(`chain: wallet deploy failed${where}: ${submit ? (submit.error?.code ?? 'unknown') : 'not submitted'}`);
  }
  const stored = await storage.get(res.credentialId);
  if (!stored || stored.contractId !== res.contractId) throw new Error('chain: the kit stored no matching credential');
  return { contractId: res.contractId, credentialId: res.credentialId, credential: serializeCredential(stored), deployTx: submit.hash };
}
