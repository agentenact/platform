import { createHash, generateKeyPairSync, randomBytes, sign as ecSign, type KeyObject } from 'node:crypto';
import type { RegistrationResponse } from '../../src/owner-client/types.js';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** A software P-256 authenticator producing real WebAuthn-format JSON (proven on testnet in gate 1). */
export function softAuthenticator(o: { rpId: string; origin: string }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) as { privateKey: KeyObject; publicKey: KeyObject };
  const credId = randomBytes(32);
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // Minimal COSE EC2 / ES256 key: {1:2, 3:-7, -1:1, -2:x, -3:y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(credId.length);
  /** Real registration authenticatorData: rpIdHash, flags UP|UV|AT, signCount, zero AAGUID, credId, COSE key. */
  const authData = Buffer.concat([sha256(o.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), credLen, credId, cose]);
  let counter = 1;
  const self = {
    credentialId: b64u(credId),
    /** The 65-byte uncompressed P-256 key, as the wallet stores it (app.users.passkey_credential.publicKey, base64url). */
    publicKey: b64u(Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    assertions: 0,
    /** An assertion with chosen defects, for refusal tests. Defaults are a correct assertion for `o.rpId` / `o.origin`. */
    assert(optionsJSON: { challenge: string }, bad: { type?: string; origin?: string; rpId?: string; flags?: number; crossOrigin?: boolean; challenge?: string; tamperSignature?: boolean } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: bad.type ?? 'webauthn.get', challenge: bad.challenge ?? optionsJSON.challenge, origin: bad.origin ?? o.origin, crossOrigin: bad.crossOrigin ?? false }));
      const cnt = Buffer.alloc(4);
      cnt.writeUInt32BE(counter++);
      const data = Buffer.concat([sha256(bad.rpId ?? o.rpId), Buffer.from([bad.flags ?? 0x05]), cnt]);
      const sig = ecSign('sha256', Buffer.concat([data, sha256(clientData)]), privateKey);
      if (bad.tamperSignature) sig[sig.length - 1] = sig[sig.length - 1]! ^ 0xff;
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(data), signature: b64u(sig) } };
    },
    webAuthn: {
      async startRegistration({ optionsJSON }: { optionsJSON: { challenge: string } }): Promise<RegistrationResponse> {
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: optionsJSON.challenge, origin: o.origin }));
        return {
          id: b64u(credId),
          rawId: b64u(credId),
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: b64u(clientData),
            attestationObject: b64u(Buffer.from('software-authenticator-no-attestation')),
            publicKey: b64u(spki),
            transports: ['internal'],
            publicKeyAlgorithm: -7,
            authenticatorData: b64u(authData),
          },
        };
      },
      async startAuthentication({ optionsJSON }: { optionsJSON: { challenge: string } }) {
        self.assertions++;
        const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: optionsJSON.challenge, origin: o.origin, crossOrigin: false }));
        const cnt = Buffer.alloc(4);
        cnt.writeUInt32BE(counter++);
        const assertionData = Buffer.concat([sha256(o.rpId), Buffer.from([0x05]) /* UP|UV */, cnt]);
        const sig = ecSign('sha256', Buffer.concat([assertionData, sha256(clientData)]), privateKey); // DER
        return {
          id: b64u(credId),
          rawId: b64u(credId),
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(assertionData), signature: b64u(sig) },
        };
      },
    },
  };
  return self;
}
