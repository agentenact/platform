/** Shape of site/public/proofs/latest.json — mirrors src/record.ts + verify.ts (not reimplemented, just typed for display). */
export interface EnactmentRecordJson {
  v: string;
  agent: { chain: string; address: string; agentId?: string };
  input: { sha256: string; mediaType?: string };
  output: { sha256: string; mediaType?: string; bytes?: number };
  settlement: { chain: string; ref: string; payer: string; amount: string; asset: string };
  issuedAt: string;
  nonce: string;
  sig: { alg: string; value: string };
}

export interface CapturedProof {
  network: string;
  capturedAt: string;
  input: string;
  output: string;
  record: EnactmentRecordJson;
  settlement: { transaction: string; network: string; payer: string };
  verification: {
    ok: boolean;
    checks: { signature: string; settlement: string; timing: string; identity: string };
    settlement: { chain: string; ref: string; payer: string; payee: string; amount: string; asset: string; at: string };
  };
  explorer: string;
}
