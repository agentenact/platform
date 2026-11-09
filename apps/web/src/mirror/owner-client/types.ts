// GENERATED, do not edit; source apps/api/src/owner-client
/** What the browser receives for one pending owner signature. */
export interface PublicSignRequest {
  id: string;
  kind: 'register' | 'bind';
  /** Our agent uuid (not the registry id). */
  agentId: string;
  /** The unsigned Soroban authorization entry, base64 XDR. */
  entryXdr: string;
  validUntilLedger: number;
  networkPassphrase: string;
  expiresAt: string;
  /** Tx source for the browser's own simulation: the platform sponsor account (exists on ledger). */
  source: string;
  /** For 'bind': the agent wallet the platform created; the entry must bind exactly this one. */
  agentWallet: string | null;
  /**
   * For 'bind': the hash of the register tx the platform submitted (null otherwise). A pointer only:
   * the browser accepts it only if that tx, read from its own RPC, carries the owner's signed entry.
   */
  registerTx: string | null;
}

/** A WebAuthn registration result as @simplewebauthn/browser returns it (JSON, base64url fields). */
export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    /** SPKI or raw uncompressed P-256 key; smart-account-kit reads the key from here. */
    publicKey?: string;
    publicKeyAlgorithm?: number;
    /** Base64url authenticator data (rpIdHash, flags, signCount, attested credential data). */
    authenticatorData?: string;
    transports?: string[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
}
