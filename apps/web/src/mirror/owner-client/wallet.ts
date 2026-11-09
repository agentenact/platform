// GENERATED, do not edit; source apps/api/src/owner-client
/**
 * The owner's passkey wallet in the browser (plan D8). No deployerSecret: the kit's shared deployer
 * is never used to derive anything because the stored credential (with its birth fields) and the
 * contract id are passed explicitly, so connectWallet takes the locally approved provenance path.
 * The kit computes the WebAuthn challenge from the entry itself.
 *
 * Verified against smart-account-kit 0.8.0 dist (2026-10-04):
 * - kit/wallet-ops.js connectWithCredentials: with both ids given, the deployer key is used only to
 *   derive a missing contractId and as `expectedDeployer` on the non-locallyApproved path. Our
 *   credential is isPrimary with birthConstructorArgsHash, birthWasmHash, creationTransactionHash
 *   and creationLedger (written by kit/deploy-ops.js on submit; chain/wallet.ts serialises it after
 *   submit), so locallyApproved holds and the birth is verified against that hash via RPC, falling
 *   back to testnet Horizon history (the kit's default) past RPC retention.
 * - No extra prompt: the locallyApproved path skips the fresh-assertion step; the only
 *   startAuthentication is kit/webauthn-ops.js signAuthEntry, challenged with the entry's digest.
 * - signAuthEntry re-reads the entry through its own sdk-16 XDR (`fromXDR(entry.toXDR())`), so an
 *   sdk-15 object crosses safely; it returns an sdk-16 entry, which leaves here as base64.
 */
import { xdr } from '@stellar/stellar-sdk';
import { MemoryStorage, SmartAccountKit, type SmartAccountConfig } from 'smart-account-kit';
import type { OwnerWallet } from './approve';
import { deserializeCredential, type SerializedCredential } from './credential';
import { TESTNET } from './testnet';

export interface OwnerWalletConfig {
  rpId: string;
  origin: string;
  rpcUrl?: string;
  /** Defaults to @simplewebauthn/browser inside the kit; tests inject a software authenticator. */
  webAuthn?: unknown;
}

export async function connectOwnerWallet(
  cfg: OwnerWalletConfig,
  w: { contractId: string; credentialId: string; credential: SerializedCredential },
): Promise<OwnerWallet> {
  const storage = new MemoryStorage();
  await storage.save(deserializeCredential(w.credential));
  const kit = new SmartAccountKit({
    rpcUrl: cfg.rpcUrl ?? TESTNET.rpcUrl,
    networkPassphrase: TESTNET.passphrase,
    accountWasmHash: TESTNET.accountWasmHash,
    webauthnVerifierAddress: TESTNET.webauthnVerifier,
    rpId: cfg.rpId,
    allowedOrigins: [cfg.origin],
    storage,
    indexerUrl: false,
    ...(cfg.webAuthn ? { webAuthn: cfg.webAuthn } : {}),
  } as unknown as SmartAccountConfig);
  const connected = await kit.connectWallet({ credentialId: w.credentialId, contractId: w.contractId });
  if (!connected || kit.contractId !== w.contractId) throw new Error('owner-client: could not connect the passkey wallet');
  const address = kit.contractId;
  // The signer is read from the wallet's context rule before the owner is asked (see `prepare`), so that signing opens the
  // passkey prompt without a network round trip: Safari/WebKit rejects a prompt that comes after one (spec: transient activation).
  let signer: unknown;
  return {
    address,
    async prepare() {
      signer = await findPasskeySigner(kit, w.credentialId);
    },
    async signEntry(entryXdr, validUntilLedger) {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
      const options = { credentialId: w.credentialId, expiration: validUntilLedger, contextRuleIds: [0] };
      // The public signAuthEntry drops `signer` and looks it up over RPC. The kit's internal method (smart-account-kit 0.8.0,
      // pinned in package.json; kit.js signAuthEntryInternal) takes it and then does no network before the prompt.
      const internal = (kit as unknown as { signAuthEntryInternal?: (e: unknown, o: unknown) => Promise<xdr.SorobanAuthorizationEntry> }).signAuthEntryInternal;
      const signed =
        signer !== undefined && typeof internal === 'function'
          ? await internal.call(kit, entry, { ...options, signer })
          : await kit.signAuthEntry(entry as never, options);
      return signed.toXDR('base64');
    },
  };
}

const b64urlBytes = (s: string): Uint8Array => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * The passkey's signer on context rule 0: the External signer whose key data ends with the credential id (the same match
 * the kit's own lookup makes, from the same rule read).
 */
export async function findPasskeySigner(kit: Pick<SmartAccountKit, 'rules'>, credentialId: string): Promise<unknown> {
  const id = b64urlBytes(credentialId);
  const { result: rule } = await kit.rules.get(0);
  for (const signer of rule.signers) {
    if (signer.tag !== 'External') continue;
    const keyData: Uint8Array = signer.values[1];
    if (keyData.length <= id.length) continue;
    const tail = keyData.slice(keyData.length - id.length);
    if (tail.every((b, i) => b === id[i])) return signer;
  }
  throw new Error('owner-client: no signer for this passkey on the wallet');
}
