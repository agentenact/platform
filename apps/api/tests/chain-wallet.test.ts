import { describe, expect, it } from 'bun:test';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { SmartAccountKit } from 'smart-account-kit';
import type { SmartAccountConfig, StoredCredential } from 'smart-account-kit';
import { createChain } from '../src/chain/index.js';
import { useDeployer, type KitFactory, type WalletKit } from '../src/chain/wallet.js';
import { walletDeployTx } from './support/sponsor-txs.js';
import { deserializeCredential } from '../src/owner-client/credential.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import type { RegistrationResponse } from '../src/owner-client/types.js';
import { contractAddress } from './support/fixtures.js';

const sponsorKp = Keypair.random();
const env = { SPONSOR_SECRET: sponsorKp.secret() };
const walletC = contractAddress(7);
const response: RegistrationResponse = {
  id: 'cred-abc_123',
  rawId: 'cred-abc_123',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'AA', publicKey: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url'), publicKeyAlgorithm: -7 },
  clientExtensionResults: {},
};

function kitFake(result: { success: boolean; hash?: string; error?: { code?: string } }) {
  const seen: { config?: SmartAccountConfig; app?: string; user?: string; lockedDuring?: boolean; deployer?: string; signed?: string } = {};
  const factory: KitFactory = (config) => {
    seen.config = config;
    // The kit's deployer slots, as smart-account-kit 0.8.0 has them.
    const kit = {
      deployerKeypair: Keypair.fromSecret(config.deployerSecret!),
      usingSharedDeployer: false,
      async signWithDeployer(_tx: unknown): Promise<void> {
        throw new Error('the kit signed with its own deployer');
      },
      get deployerPublicKey() {
        return kit.deployerKeypair.publicKey();
      },
      async createWallet(app: string, user: string) {
        seen.deployer = kit.deployerPublicKey;
        const deployTx = walletDeployTx(kit.deployerPublicKey);
        const assembled = {
          signed: undefined as string | undefined,
          async sign(o: { signTransaction: (x: string) => Promise<{ signedTxXdr: string }> }) {
            assembled.signed = (await o.signTransaction(deployTx.toXDR())).signedTxXdr;
          },
        };
        await kit.signWithDeployer(assembled);
        seen.signed = assembled.signed;
        seen.app = app;
        seen.user = user;
        const reg = await config.webAuthn!.startRegistration({ optionsJSON: { challenge: 'kit-own-challenge' } as never });
        const stored: StoredCredential = {
          credentialId: reg.id,
          publicKey: new Uint8Array(65).fill(4),
          contractId: walletC,
          createdAt: 1759572000000,
          isPrimary: true,
          deploymentStatus: result.success ? 'deployed' : 'failed',
          birthWasmHash: TESTNET.accountWasmHash,
          creationTransactionHash: result.hash,
          creationLedger: 5001,
          birthConstructorArgsHash: 'ab'.repeat(32),
        };
        await config.storage!.save(stored);
        return { credentialId: reg.id, contractId: walletC, submitResult: result };
      },
    };
    return kit;
  };
  return { seen, factory };
}

describe('chain.deployPasskeyWallet', () => {
  it('deploys through the kit with our sponsor as deployer, the browser response, no indexer', async () => {
    const k = kitFake({ success: true, hash: 'd'.repeat(64) });
    const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env, createKit: k.factory });
    const out = await c.deployPasskeyWallet(response, 'kerem@example.com');

    expect(out.contractId).toBe(walletC);
    expect(out.credentialId).toBe(response.id);
    expect(out.deployTx).toBe('d'.repeat(64));
    expect(deserializeCredential(out.credential).publicKey).toEqual(new Uint8Array(65).fill(4));
    expect(JSON.parse(JSON.stringify(out.credential)).birthConstructorArgsHash).toBe('ab'.repeat(32));

    const cfg = k.seen.config!;
    // The kit never sees the sponsor secret: our sponsor is its deployer, and signs what the kit asks it to.
    expect(cfg.deployerSecret).not.toBe(env.SPONSOR_SECRET);
    expect(k.seen.deployer).toBe(sponsorKp.publicKey());
    const signed = TransactionBuilder.fromXDR(k.seen.signed!, TESTNET.passphrase);
    expect(signed.signatures.length).toBe(1);
    expect(sponsorKp.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
    expect(cfg.rpId).toBe('agentenact.io');
    expect(cfg.allowedOrigins).toEqual(['https://app.agentenact.io']);
    expect(cfg.accountWasmHash).toBe(TESTNET.accountWasmHash);
    expect(cfg.webauthnVerifierAddress).toBe(TESTNET.webauthnVerifier);
    expect(cfg.networkPassphrase).toBe(TESTNET.passphrase);
    expect((cfg as { indexerUrl?: unknown }).indexerUrl).toBe(false);
    expect([k.seen.app, k.seen.user]).toEqual(['AgentEnact', 'kerem@example.com']);
    await expect(cfg.webAuthn!.startAuthentication({ optionsJSON: { challenge: 'x' } as never })).rejects.toThrow(/never asks for a passkey assertion/);
  });

  it('gives the kit every accepted origin, canonical first, deduplicated', async () => {
    const k = kitFake({ success: true, hash: 'd'.repeat(64) });
    const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', origins: ['https://agentenact.io', 'https://app.agentenact.io'], env, createKit: k.factory });
    await c.deployPasskeyWallet(response, 'kerem@example.com');
    expect(k.seen.config!.allowedOrigins).toEqual(['https://app.agentenact.io', 'https://agentenact.io']);
    expect(k.seen.config!.rpId).toBe('agentenact.io');
  });

  it('holds the sponsor lock for the whole deploy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const k = kitFake({ success: true, hash: 'd'.repeat(64) });
    const slow: KitFactory = (config) => {
      const inner = k.factory(config);
      const create = inner.createWallet.bind(inner);
      inner.createWallet = async (...a) => (await gate, create(...a));
      return inner;
    };
    const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env, createKit: slow });
    const deploy = c.deployPasskeyWallet(response, 'kerem@example.com');
    let otherIn = false;
    const other = c.withSponsorLock(async () => {
      otherIn = true;
    });
    await Bun.sleep(20);
    expect(otherIn).toBe(false);
    release();
    await deploy;
    await other;
    expect(otherIn).toBe(true);
  });

  it('a failed deploy throws with the tx hash and code, never the sponsor secret', async () => {
    const k = kitFake({ success: false, hash: 'e'.repeat(64), error: { code: 'SUBMISSION_FAILED' } });
    const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env, createKit: k.factory });
    const err = await c.deployPasskeyWallet(response, 'kerem@example.com').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`chain: wallet deploy failed (tx ${'e'.repeat(64)}): SUBMISSION_FAILED`);
    expect((err as Error).message).not.toContain(env.SPONSOR_SECRET);
  });

  it('a kit that throws is wrapped as "chain: wallet deploy failed: <code>", never its own message', async () => {
    const throwing = (e: unknown): KitFactory => (config) => {
      const kit = kitFake({ success: true }).factory(config);
      kit.createWallet = async () => {
        throw e;
      };
      return kit;
    };
    const cases: [unknown, string][] = [
      [Object.assign(new Error(`rpc said ${env.SPONSOR_SECRET}`), { code: 'SIMULATION_FAILED' }), 'chain: wallet deploy failed: SIMULATION_FAILED'],
      [new Error(`boom ${env.SPONSOR_SECRET}`), 'chain: wallet deploy failed: kit_error'],
      [Object.assign(new Error('x'), { code: 'not a code; with spaces' }), 'chain: wallet deploy failed: kit_error'],
    ];
    for (const [thrown, message] of cases) {
      const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env, createKit: throwing(thrown) });
      const err = await c.deployPasskeyWallet(response, 'kerem@example.com').catch((e: Error) => e);
      expect((err as Error).message).toBe(message);
    }
    const ctorThrows: KitFactory = () => {
      throw Object.assign(new Error('bad config'), { code: 'CONFIG_INVALID' });
    };
    const c = createChain({ rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env, createKit: ctorThrows });
    expect(((await c.deployPasskeyWallet(response, 'u').catch((e: Error) => e)) as Error).message).toBe('chain: wallet deploy failed: CONFIG_INVALID');
  });
});

describe('useDeployer on the real smart-account-kit', () => {
  const config = () =>
    ({
      rpcUrl: TESTNET.rpcUrl,
      networkPassphrase: TESTNET.passphrase,
      accountWasmHash: TESTNET.accountWasmHash,
      webauthnVerifierAddress: TESTNET.webauthnVerifier,
      rpId: 'agentenact.io',
      allowedOrigins: ['https://app.agentenact.io'],
      deployerSecret: Keypair.random().secret(),
      indexerUrl: false,
    }) as unknown as SmartAccountConfig;

  it('the pinned kit has the slots: our deployer derives the address and signs through the signer', async () => {
    const kit = new SmartAccountKit(config());
    const seen: string[] = [];
    useDeployer(kit as unknown as WalletKit, { publicKey: sponsorKp.publicKey(), signTransaction: async (x) => (seen.push(x), x) });
    expect(kit.deployerPublicKey).toBe(sponsorKp.publicKey());
    const tx = walletDeployTx(sponsorKp.publicKey());
    let got: string | undefined;
    await (kit as unknown as { signWithDeployer(t: unknown): Promise<void> }).signWithDeployer({
      sign: async (o: { signTransaction: (x: string) => Promise<{ signedTxXdr: string; signerAddress: string }> }) => {
        const r = await o.signTransaction(tx.toXDR());
        got = r.signerAddress;
      },
    });
    expect(seen).toEqual([tx.toXDR()]);
    expect(got).toBe(sponsorKp.publicKey());
  });

  it('a kit without the slots fails before anything is built', () => {
    expect(() => useDeployer({ createWallet: async () => ({}) } as unknown as WalletKit, { publicKey: sponsorKp.publicKey(), signTransaction: async (x) => x })).toThrow(/no deployer slots/);
  });
});
