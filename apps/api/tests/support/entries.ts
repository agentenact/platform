import { Address, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { TESTNET } from '../../src/owner-client/testnet.js';

export const scv = {
  addr: (a: string) => Address.fromString(a).toScVal(),
  str: (s: string) => nativeToScVal(s, { type: 'string' }),
  u32: (n: number) => nativeToScVal(n, { type: 'u32' }),
  i128: (n: bigint) => nativeToScVal(n, { type: 'i128' }),
};

export function invocation(contract: string, fn: string, args: xdr.ScVal[], sub: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contract).toScAddress(), functionName: fn, args }),
    ),
    subInvocations: sub,
  });
}

/** An unsigned entry as a recording simulation returns it. */
export function authEntry(o: {
  signer: string;
  contract?: string;
  fn: string;
  args: xdr.ScVal[];
  sub?: xdr.SorobanAuthorizedInvocation[];
  source?: boolean;
  nonce?: number;
}): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: o.source
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(o.signer).toScAddress(),
            nonce: new xdr.Int64(o.nonce ?? 777),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          }),
        ),
    rootInvocation: invocation(o.contract ?? TESTNET.registry, o.fn, o.args, o.sub),
  });
}

/** Stands in for the passkey: fills expiry and a non-void signature, keeps everything else. */
export function signEntry(e: xdr.SorobanAuthorizationEntry, validUntil: number): xdr.SorobanAuthorizationEntry {
  const out = xdr.SorobanAuthorizationEntry.fromXDR(e.toXDR());
  const c = out.credentials().address();
  c.signatureExpirationLedger(validUntil);
  c.signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
  return out;
}

export const b64 = (e: xdr.SorobanAuthorizationEntry) => e.toXDR('base64');

/** The set_agent_wallet auth-entry preimage provisioning asks the vault to sign (signBindEntry). */
export function bindPreimage(owner: string, agent: string, agentId = 77, registry: string = TESTNET.registry): string {
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(TESTNET.passphrase)),
      nonce: new xdr.Int64(Math.floor(Math.random() * 1e9)),
      signatureExpirationLedger: 5000,
      invocation: invocation(registry, 'set_agent_wallet', [scv.addr(owner), scv.u32(agentId), scv.addr(agent)]),
    }),
  ).toXDR('base64');
}
