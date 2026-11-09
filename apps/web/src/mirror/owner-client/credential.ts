// GENERATED, do not edit; source apps/api/src/owner-client
import type { StoredCredential } from 'smart-account-kit';

/** StoredCredential as JSON: the 65-byte P-256 key as base64url (a Uint8Array does not survive JSON). */
export type SerializedCredential = Omit<StoredCredential, 'publicKey'> & { publicKey: string };

/** Browser-safe base64url (no Buffer). */
function toB64Url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const serializeCredential = (c: StoredCredential): SerializedCredential => ({
  ...c,
  publicKey: toB64Url(c.publicKey),
});

export const deserializeCredential = (s: SerializedCredential): StoredCredential => {
  const publicKey = fromB64Url(s.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('credential public key is not an uncompressed P-256 key');
  return { ...s, publicKey };
};
