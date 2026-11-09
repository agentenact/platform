/**
 * The browser never signs on the server's say-so (spec §5.1). Before any passkey prompt the
 * browser decodes the auth entry itself and accepts exactly three registry calls, for the
 * owner's own wallet, with no nested invocations. Pure: no network, no server imports.
 */
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

export const ALLOWED_FUNCTIONS = ['register_with_uri', 'set_agent_wallet', 'unset_agent_wallet'] as const;

export type AllowedCall =
  | { fn: 'register_with_uri'; owner: string; agentUri: string }
  | { fn: 'set_agent_wallet'; owner: string; agentId: number; wallet: string }
  | { fn: 'unset_agent_wallet'; owner: string; agentId: number };

export interface Expected {
  /** The connected passkey wallet (C…), as the browser's own kit reports it. */
  owner: string;
  registry: string;
  /** Every agentURI we register starts with this, e.g. https://agentenact.io/a/ */
  uriPrefix: string;
  /** For a bind: the agent wallet the owner is creating. */
  agentWallet?: string | null;
  /**
   * For set/unset: the registry agent id the owner is acting on. The browser must obtain it
   * independently (a registry read, or the user's own selection), never from the server.
   */
  agentId?: number;
}

export type CheckResult = { ok: true; call: AllowedCall; summary: string } | { ok: false; reason: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkAgentId(entryId: number, expected: Expected): CheckResult | null {
  if (expected.agentId === undefined) return refuse('no agent id to compare against');
  if (entryId !== expected.agentId) return refuse(`acts on agent #${entryId}, not the one you selected (#${expected.agentId})`);
  return null;
}

const refuse = (reason: string): CheckResult => ({ ok: false, reason });

function addressOf(v: xdr.ScVal | undefined): string | null {
  if (!v || v.switch() !== xdr.ScValType.scvAddress()) return null;
  try {
    return Address.fromScVal(v).toString();
  } catch {
    return null;
  }
}
const u32Of = (v: xdr.ScVal | undefined): number | null => (v && v.switch() === xdr.ScValType.scvU32() ? v.u32() : null);
const stringOf = (v: xdr.ScVal | undefined): string | null => (v && v.switch() === xdr.ScValType.scvString() ? v.str().toString() : null);

export function checkEntry(entryXdr: string, expected: Expected): CheckResult {
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  } catch {
    return refuse('not a Soroban authorization entry');
  }
  const creds = entry.credentials();
  if (creds.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return refuse('not an address-credential entry');
  const signer = Address.fromScAddress(creds.address().address()).toString();
  if (signer !== expected.owner) return refuse(`asks ${signer} to sign, not your wallet`);

  const inv = entry.rootInvocation();
  if (inv.subInvocations().length > 0) return refuse('authorises nested calls');
  const fnx = inv.function();
  if (fnx.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) return refuse('not a contract call');
  const call = fnx.contractFn();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  if (contract !== expected.registry) return refuse(`calls ${contract}, not the identity registry`);
  const fn = call.functionName().toString();
  const args = call.args();
  if (!(ALLOWED_FUNCTIONS as readonly string[]).includes(fn)) return refuse(`${fn} is not allowed`);

  if (fn === 'register_with_uri') {
    const uri = args.length === 2 ? stringOf(args[1]) : null;
    if (uri === null || addressOf(args[0]) === null) return refuse('register_with_uri has unexpected arguments');
    if (addressOf(args[0]) !== expected.owner) return refuse('the caller argument is not your wallet');
    if (!expected.uriPrefix.endsWith('/')) return refuse('the agent URI prefix must end with /');
    if (uri.length > 256) return refuse('the agent URI is too long');
    if (!new RegExp(`^${escapeRe(expected.uriPrefix)}[0-9a-f-]{36}/agent\\.json$`).test(uri)) {
      return refuse(`the agent URI ${uri} is not on ${expected.uriPrefix}`);
    }
    return {
      ok: true,
      call: { fn: 'register_with_uri', owner: expected.owner, agentUri: uri },
      summary: `Create a new agent identity owned by your wallet, described at ${uri}.`,
    };
  }

  if (fn === 'set_agent_wallet') {
    const agentId = args.length === 3 ? u32Of(args[1]) : null;
    const wallet = args.length === 3 ? addressOf(args[2]) : null;
    if (agentId === null || wallet === null || addressOf(args[0]) === null) return refuse('set_agent_wallet has unexpected arguments');
    if (addressOf(args[0]) !== expected.owner) return refuse('the caller argument is not your wallet');
    const idRefusal = checkAgentId(agentId, expected);
    if (idRefusal) return idRefusal;
    if (!StrKey.isValidEd25519PublicKey(wallet)) return refuse('the agent wallet is not an account address');
    if (!expected.agentWallet) return refuse('no agent wallet to compare against');
    if (wallet !== expected.agentWallet) return refuse(`binds a different wallet (${wallet}) than your agent's (${expected.agentWallet})`);
    return {
      ok: true,
      call: { fn: 'set_agent_wallet', owner: expected.owner, agentId, wallet },
      summary: `Let agent #${agentId} act with its own wallet ${wallet}.`,
    };
  }

  // unset_agent_wallet
  const agentId = args.length === 2 ? u32Of(args[1]) : null;
  if (agentId === null || addressOf(args[0]) === null) return refuse('unset_agent_wallet has unexpected arguments');
  if (addressOf(args[0]) !== expected.owner) return refuse('the caller argument is not your wallet');
  const idRefusal = checkAgentId(agentId, expected);
  if (idRefusal) return idRefusal;
  return {
    ok: true,
    call: { fn: 'unset_agent_wallet', owner: expected.owner, agentId },
    summary: `Remove the wallet of agent #${agentId}. Records it already signed stop verifying.`,
  };
}
