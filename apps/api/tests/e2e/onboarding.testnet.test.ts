import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import type { AuthVerifier } from '../../src/account/auth.js';
import { createPasskeyAccount } from '../../src/account/passkey.js';
import { createSignRequests } from '../../src/account/sign-requests.js';
import { createChain } from '../../src/chain/index.js';
import type { Db } from '../../src/db/index.js';
import { createApp, type App } from '../../src/gateway/app.js';
import { createKeys } from '../../src/keys/index.js';
import { localAgentKeys } from '../../src/keys/rpc.js';
import { createVault } from '../../src/keys/vault.js';
import { approveSignRequest, type Approval, type ApproveContext, type OwnerWallet } from '../../src/owner-client/approve.js';
import { TESTNET } from '../../src/owner-client/testnet.js';
import type { PublicSignRequest } from '../../src/owner-client/types.js';
import { connectOwnerWallet } from '../../src/owner-client/wallet.js';
import { createProvisioner } from '../../src/provision/index.js';
import { freshDb } from '../support/db.js';
import { minimalSpec } from '../support/specs.js';
import { softAuthenticator } from '../support/soft-authenticator.js';

// Opt-in. Needs Docker Postgres (TEST_DATABASE_URL) and Stellar testnet. No secrets on disk: the
// sponsor (friendbot) and KEYS_MASTER_SECRET are generated in beforeAll. Run from apps/api:
//   AGENTENACT_TESTNET=1 TEST_DATABASE_URL=postgres://postgres:test@localhost:55439/agentenact_cloud_test \
//     bun test tests/e2e/onboarding.testnet.test.ts
// Real everything except: auth (a fixed-token AuthVerifier) and the browser (software P-256
// authenticator driving owner-client exactly as the web panel will).
const live = process.env.AGENTENACT_TESTNET === '1';
const RP_ID = 'agentenact.io';
const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io'; // request host only; the handler routes on the path
const BASE = 'https://public.example.test'; // placeholder public base registered on testnet
const URI_PREFIX = `${BASE}/a/`; // what the web app would be compiled with
const TOKEN = 'e2e-session';

/** Refusals that read as RPC lag, not as a check failing: the UI retries these. */
const LAG = /cannot read agent #|the registration is not on chain|cannot read the registration tx|simulation unavailable|cannot read the latest ledger/;

describe.skipIf(!live)('onboarding on Stellar testnet: passkey owner → registered and bound agent', () => {
  let sql: Db;
  let drop: (() => Promise<void>) | undefined;
  let app: App;
  let soft: ReturnType<typeof softAuthenticator>;
  const events: Record<string, unknown>[] = [];

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const sponsorKp = Keypair.random();
    const fb = await fetch(`https://friendbot.stellar.org/?addr=${sponsorKp.publicKey()}`);
    if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
    // Wired as main.ts wires it: one WebAuthn identity for the passkey unit and the chain kit.
    const webauthn = { rpId: RP_ID, origin: ORIGIN } as const;
    const chain = createChain({ ...webauthn, env: { SPONSOR_SECRET: sponsorKp.secret() } });
    const keys = localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }) }));
    const signRequests = createSignRequests(sql, { source: chain.sponsorPublicKey, pollMs: 500, latestLedger: () => chain.soroban.latestLedger!() });
    const log = (e: Record<string, unknown>) => void events.push(e); // public data only (codes, hashes, ids)
    // Observation only, for failure evidence: provision never logs an error (it may carry the agent key),
    // so the seams it calls report their own failures here. Both throw fixed words and public data.
    const observe = <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      try {
        return await f(...a);
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown };
        log({ event: 'seam_failed', seam: name, code: String(err.code ?? ''), message: String(err.message ?? '').slice(0, 600) });
        throw e;
      }
    };
    const s = chain.soroban;
    const observedChain = {
      ...chain,
      soroban: { ...s, getAccount: observe('getAccount', s.getAccount), send: observe('send', s.send), prepare: observe('prepare', s.prepare!), confirm: observe('confirm', s.confirm!), latestLedger: observe('latestLedger', s.latestLedger!) },
      horizonSubmit: observe('horizonSubmit', chain.horizonSubmit),
    };
    const provisioner = createProvisioner({ sql, keys, chain: observedChain, signRequests: { request: observe('signRequest', signRequests.request) }, publicBaseUrl: BASE, log });
    const user = { id: crypto.randomUUID(), email: 'e2e@agentenact.io' };
    const verify: AuthVerifier = async (t) => (t === TOKEN ? user : null);
    app = createApp({ sql, verify, passkey: createPasskeyAccount({ sql, chain, ...webauthn }), signRequests, provisioner, appOrigin: ORIGIN, log });
    soft = softAuthenticator(webauthn);
  }, 60_000);
  afterAll(async () => drop?.());

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app(
      new Request(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  /** As the UI would: retry lag-shaped refusals a few times; any other refusal is final. */
  async function approve(req: PublicSignRequest, wallet: OwnerWallet, ctx: ApproveContext): Promise<Approval> {
    for (let i = 0; ; i++) {
      try {
        return await approveSignRequest(req, wallet, ctx);
      } catch (e) {
        const msg = (e as Error).message;
        if (i >= 5 || !LAG.test(msg)) throw new Error(`approve ${req.kind}: ${msg}`);
        await Bun.sleep(2_000);
      }
    }
  }

  it('wallet → agent → two passkey approvals → the registry names the C wallet as owner and the runtime key as wallet', async () => {
    try {
      // 1. Passkey wallet: the browser ceremony, then the sponsor-deployed smart account.
      const opts = await call('POST', '/api/passkey/options');
      expect(opts.status).toBe(200);
      const reg = await call('POST', '/api/passkey/register', { response: await soft.webAuthn.startRegistration(opts.body) });
      expect(reg).toMatchObject({ status: 200 });
      const ownerC: string = reg.body.ownerAddress;
      expect(ownerC).toMatch(/^C[A-Z2-7]{55}$/);

      // 2. The browser connects its own kit to that wallet (no deployer secret, explicit ids).
      const wallet = (await call('GET', '/api/wallet')).body;
      const owner = await connectOwnerWallet({ rpId: RP_ID, origin: ORIGIN, webAuthn: soft.webAuthn }, wallet);
      expect(owner.address).toBe(ownerC);
      expect(soft.assertions).toBe(0);

      // 3. Create the agent and approve each owner entry as the panel would. The register approval is
      //    browser state only; the bind request's registerTx is the server's pointer, verified on chain.
      const created = await call('POST', '/api/agents', { name: 'e2e agent', spec: minimalSpec() });
      expect(created.status).toBe(202);
      const id: string = created.body.id;
      const server = new rpc.Server(TESTNET.rpcUrl); // the public testnet RPC, never our API
      const summaries = new Map<string, string>(); // per request id: a lag retry may confirm twice
      let registerApproval: Approval | undefined; // browser storage: never from the API
      let registerTxFromServer: string | null = null;
      const deadline = Date.now() + 240_000;
      let agent = (await call('GET', `/api/agents/${id}`)).body;
      while (agent.status !== 'active' && agent.provision.step !== 'failed') {
        if (Date.now() > deadline) throw new Error(`timed out at step ${agent.provision.step}`);
        for (const req of (await call('GET', '/api/sign-requests')).body as PublicSignRequest[]) {
          if (req.kind === 'bind') {
            if (!registerApproval) throw new Error('browser: a bind was asked before any register approval');
            // The server's pointer; approveSignRequest reads that tx from the public RPC and checks it carries our approval.
            expect(req.registerTx).toMatch(/^[0-9a-f]{64}$/);
            registerTxFromServer = req.registerTx;
          }
          const approval = await approve(req, owner, {
            rpc: server,
            uriPrefix: URI_PREFIX,
            confirm: async (s) => (summaries.set(req.id, s), true),
            ...(req.kind === 'bind' && registerApproval ? { registered: { approval: registerApproval } } : {}),
          });
          if (req.kind === 'register') registerApproval = approval;
          const posted = await call('POST', `/api/sign-requests/${req.id}/sign`, { signedEntryXdr: approval.signedEntryXdr });
          expect(posted.status).toBe(204);
        }
        await Bun.sleep(1_000);
        agent = (await call('GET', `/api/agents/${id}`)).body;
      }

      expect(agent.provision.error).toBeUndefined();
      expect(agent.status).toBe('active');
      expect(summaries.size).toBe(2);
      expect(soft.assertions).toBe(2); // register + bind; wallet creation was the first ceremony
      expect(registerTxFromServer).toBe(agent.provision.attempts.at(-1).txs.register);

      // 4. Read the identity back from public chain data (registry reads may lag: retry briefly).
      const adapter = createStellarAdapter({ network: 'testnet' });
      let binding = await adapter.resolveIdentity(agent.agentId);
      for (let i = 0; i < 5 && (!binding || binding.wallet !== agent.stellarAddress); i++) {
        await Bun.sleep(2_000);
        binding = await adapter.resolveIdentity(agent.agentId);
      }
      expect(binding).toEqual({ owner: ownerC, wallet: agent.stellarAddress });
      const doc = await app(new Request(`${API}/a/${id}/agent.json`));
      expect(await doc.json()).toEqual({ name: 'e2e agent', description: '', services: [], agentId: Number(agent.agentId), agentWallet: agent.stellarAddress });

      // Public data only, for the commit body.
      console.log(
        JSON.stringify({
          agentId: agent.agentId,
          owner: ownerC,
          wallet: agent.stellarAddress,
          deployTx: wallet.credential.creationTransactionHash,
          txs: agent.provision.attempts.at(-1).txs,
          registerTxFromServer,
        }),
      );
    } catch (e) {
      // Evidence on failure: the public log events (codes, hashes, ids), never an error object from provision.
      console.log(JSON.stringify({ events }));
      throw e;
    }
  }, 300_000);
});
