import { describe, expect, it } from 'bun:test';
import { Asset, Keypair, xdr } from '@stellar/stellar-sdk';
import { checkEntry, type Expected } from '../src/owner-client/check.js';
import { deserializeCredential, serializeCredential } from '../src/owner-client/credential.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { authEntry, b64, invocation, scv } from './support/entries.js';
import { contractAddress } from './support/fixtures.js';

const owner = contractAddress(7);
const agentG = Keypair.random().publicKey();
const prefix = 'https://public.example.test/a/';
const uri = `${prefix}0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e/agent.json`;
const expected: Expected = { owner, registry: TESTNET.registry, uriPrefix: prefix, agentWallet: agentG, agentId: 42 };

const register = (args = [scv.addr(owner), scv.str(uri)]) => b64(authEntry({ signer: owner, fn: 'register_with_uri', args }));
const bind = (wallet = agentG, id = 42) => b64(authEntry({ signer: owner, fn: 'set_agent_wallet', args: [scv.addr(owner), scv.u32(id), scv.addr(wallet)] }));

describe('checkEntry: the browser allowlist', () => {
  it('accepts register_with_uri for the owner, on our agent URI prefix', () => {
    const r = checkEntry(register(), expected);
    expect(r).toEqual({
      ok: true,
      call: { fn: 'register_with_uri', owner, agentUri: uri },
      summary: `Create a new agent identity owned by your wallet, described at ${uri}.`,
    });
  });

  it('accepts set_agent_wallet binding exactly the expected agent wallet', () => {
    const r = checkEntry(bind(), expected);
    expect(r.ok && r.call).toEqual({ fn: 'set_agent_wallet', owner, agentId: 42, wallet: agentG });
  });

  it('accepts unset_agent_wallet for the owner', () => {
    const r = checkEntry(b64(authEntry({ signer: owner, fn: 'unset_agent_wallet', args: [scv.addr(owner), scv.u32(42)] })), expected);
    expect(r.ok && r.call).toEqual({ fn: 'unset_agent_wallet', owner, agentId: 42 });
  });

  it('REJECTS a crafted USDC SAC transfer from the owner wallet', () => {
    const transfer = authEntry({
      signer: owner,
      contract: TESTNET.usdcSac,
      fn: 'transfer',
      args: [scv.addr(owner), scv.addr(Keypair.random().publicKey()), scv.i128(1_000_000_000n)],
    });
    expect(checkEntry(b64(transfer), expected)).toEqual({ ok: false, reason: `calls ${TESTNET.usdcSac}, not the identity registry` });
  });

  it('rejects a transfer hidden under an allowlisted call', () => {
    const hidden = authEntry({
      signer: owner,
      fn: 'register_with_uri',
      args: [scv.addr(owner), scv.str(uri)],
      sub: [invocation(TESTNET.usdcSac, 'transfer', [scv.addr(owner), scv.addr(agentG), scv.i128(1n)])],
    });
    expect(checkEntry(b64(hidden), expected)).toEqual({ ok: false, reason: 'authorises nested calls' });
  });

  it('rejects a non-allowlisted function on the registry itself', () => {
    const r = checkEntry(b64(authEntry({ signer: owner, fn: 'transfer_ownership', args: [scv.addr(owner)] })), expected);
    expect(r).toEqual({ ok: false, reason: 'transfer_ownership is not allowed' });
  });

  it('rejects an allowlisted name on another contract', () => {
    const other = contractAddress(9);
    const r = checkEntry(b64(authEntry({ signer: owner, contract: other, fn: 'register_with_uri', args: [scv.addr(owner), scv.str(uri)] })), expected);
    expect(r).toEqual({ ok: false, reason: `calls ${other}, not the identity registry` });
  });

  it('rejects a bind to a different wallet than the agent we created (a server-crafted rebind)', () => {
    const attacker = Keypair.random().publicKey();
    expect(checkEntry(bind(attacker), expected)).toEqual({
      ok: false,
      reason: `binds a different wallet (${attacker}) than your agent's (${agentG})`,
    });
  });

  it('rejects a bind when there is no agent wallet to compare against', () => {
    expect(checkEntry(bind(), { ...expected, agentWallet: null })).toEqual({ ok: false, reason: 'no agent wallet to compare against' });
  });

  it('rejects a bind to a contract address', () => {
    expect(checkEntry(bind(contractAddress(3)), expected)).toEqual({ ok: false, reason: 'the agent wallet is not an account address' });
  });

  it('rejects an agent URI outside our prefix', () => {
    const r = checkEntry(register([scv.addr(owner), scv.str('https://evil.example/agent.json')]), expected);
    expect(r).toEqual({ ok: false, reason: `the agent URI https://evil.example/agent.json is not on ${prefix}` });
  });

  it('rejects a caller argument that is not the owner', () => {
    const r = checkEntry(register([scv.addr(contractAddress(5)), scv.str(uri)]), expected);
    expect(r).toEqual({ ok: false, reason: 'the caller argument is not your wallet' });
  });

  it('rejects wrong argument shapes', () => {
    expect(checkEntry(register([scv.addr(owner), scv.u32(1)]), expected)).toEqual({ ok: false, reason: 'register_with_uri has unexpected arguments' });
    const badBind = b64(authEntry({ signer: owner, fn: 'set_agent_wallet', args: [scv.addr(owner), scv.str('42'), scv.addr(agentG)] }));
    expect(checkEntry(badBind, expected)).toEqual({ ok: false, reason: 'set_agent_wallet has unexpected arguments' });
  });

  it('rejects an entry for another signer, a source-account entry, a create-contract entry and garbage', () => {
    const stranger = contractAddress(4);
    expect(checkEntry(b64(authEntry({ signer: stranger, fn: 'register_with_uri', args: [scv.addr(owner), scv.str(uri)] })), expected))
      .toEqual({ ok: false, reason: `asks ${stranger} to sign, not your wallet` });
    expect(checkEntry(b64(authEntry({ signer: owner, source: true, fn: 'register_with_uri', args: [] })), expected))
      .toEqual({ ok: false, reason: 'not an address-credential entry' });
    const create = authEntry({ signer: owner, fn: 'register_with_uri', args: [] });
    create.rootInvocation(
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(Asset.native().toXDRObject()),
            executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          }),
        ),
        subInvocations: [],
      }),
    );
    expect(checkEntry(b64(create), expected)).toEqual({ ok: false, reason: 'not a contract call' });
    expect(checkEntry('AAAA', expected)).toEqual({ ok: false, reason: 'not a Soroban authorization entry' });
  });

  it('credential codec round-trips the 65-byte key through JSON', () => {
    const key = new Uint8Array(65).fill(4);
    const stored = { credentialId: 'abc', publicKey: key, contractId: owner, createdAt: 1, isPrimary: true };
    const wire = JSON.parse(JSON.stringify(serializeCredential(stored)));
    expect(wire.publicKey).toBe(Buffer.from(key).toString('base64url'));
    expect(deserializeCredential(wire)).toEqual(stored);
  });
  it('rejects set/unset when the agent id is absent or differs from the independently known one', () => {
    const unset = (id = 42) => b64(authEntry({ signer: owner, fn: 'unset_agent_wallet', args: [scv.addr(owner), scv.u32(id)] }));
    const noId: Expected = { ...expected, agentId: undefined };
    expect(checkEntry(bind(), noId)).toEqual({ ok: false, reason: 'no agent id to compare against' });
    expect(checkEntry(unset(), noId)).toEqual({ ok: false, reason: 'no agent id to compare against' });
    expect(checkEntry(bind(agentG, 43), expected)).toEqual({ ok: false, reason: 'acts on agent #43, not the one you selected (#42)' });
    expect(checkEntry(unset(43), expected)).toEqual({ ok: false, reason: 'acts on agent #43, not the one you selected (#42)' });
    expect(checkEntry(unset(42), expected).ok).toBe(true);
    expect(checkEntry(bind(agentG, 42), expected).ok).toBe(true);
  });

  it('accepts only the exact agent URI shape', () => {
    const bad = (u: string) => checkEntry(register([scv.addr(owner), scv.str(u)]), expected);
    const id = '0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e';
    for (const u of [
      `${prefix}../../x\n/agent.json`,
      `${prefix}${id}/agent.json\n`,
      `${prefix}not-a-uuid/agent.json`,
      `${prefix}${id}/agent.json/extra`,
      `${prefix}${id}/other.json`,
      'https://public.example.test.evil.com/a/' + id + '/agent.json',
    ]) expect(bad(u)).toEqual({ ok: false, reason: `the agent URI ${u} is not on ${prefix}` });
    const long = `${prefix}${id}/agent.json`.padEnd(300, 'x');
    expect(bad(long)).toEqual({ ok: false, reason: 'the agent URI is too long' });
    expect(checkEntry(register(), { ...expected, uriPrefix: 'https://public.example.test/a' })).toEqual({ ok: false, reason: 'the agent URI prefix must end with /' });
  });

  it('rejects wrong callers, wrong arity and trailing XDR bytes', () => {
    const stranger = contractAddress(5);
    const unsetE = (args: xdr.ScVal[]) => b64(authEntry({ signer: owner, fn: 'unset_agent_wallet', args }));
    expect(checkEntry(unsetE([scv.addr(owner), scv.str('42')]), expected)).toEqual({ ok: false, reason: 'unset_agent_wallet has unexpected arguments' });
    expect(checkEntry(unsetE([scv.addr(stranger), scv.u32(42)]), expected)).toEqual({ ok: false, reason: 'the caller argument is not your wallet' });
    const setE = b64(authEntry({ signer: owner, fn: 'set_agent_wallet', args: [scv.addr(stranger), scv.u32(42), scv.addr(agentG)] }));
    expect(checkEntry(setE, expected)).toEqual({ ok: false, reason: 'the caller argument is not your wallet' });
    expect(checkEntry(register([scv.addr(owner), scv.str(uri), scv.u32(1)]), expected)).toEqual({ ok: false, reason: 'register_with_uri has unexpected arguments' });
    const padded = Buffer.concat([Buffer.from(register(), 'base64'), Buffer.from([0, 0, 0, 0])]).toString('base64');
    expect(checkEntry(padded, expected)).toEqual({ ok: false, reason: 'not a Soroban authorization entry' });
  });

  it('credential codec rejects a key that is not 65 bytes starting 0x04', () => {
    const mk = (k: Uint8Array) => ({ credentialId: 'abc', publicKey: Buffer.from(k).toString('base64url'), contractId: owner, createdAt: 1, isPrimary: true });
    expect(() => deserializeCredential(mk(new Uint8Array(64).fill(4)))).toThrow();
    expect(() => deserializeCredential(mk(new Uint8Array(65).fill(5)))).toThrow();
  });
});
