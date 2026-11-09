import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import { createStellarAgent } from 'agentenact/create';
import { verifyRecord } from 'agentenact';
import { hire } from 'agentenact/hire';
import type { Db } from '../../src/db/index.js';
import { createApp } from '../../src/gateway/app.js';
import { createKeys, type Keys } from '../../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../../src/keys/rpc.js';
import { createVault } from '../../src/keys/vault.js';
import { BUDGETS } from '../../src/loop/budgets.js';
import { createRunner } from '../../src/loop/index.js';
import { createOwnerRuns } from '../../src/loop/owner.js';
import { createOpenRouterSearch } from '../../src/loop/search.js';
import { createServiceRunner } from '../../src/loop/service.js';
import { TESTNET } from '../../src/owner-client/testnet.js';
import { createPolicy } from '../../src/policy/index.js';
import { createSpend } from '../../src/policy/spend.js';
import { createRecords } from '../../src/records/index.js';
import { createRuns } from '../../src/runs/index.js';
import { createMemory } from '../../src/runs/memory.js';
import { createHirer, type HireOutcome } from '../../src/signer/hire.js';
import { createServiceEndpoint } from '../../src/signer/serve.js';
import { createSpecs } from '../../src/specs/index.js';
import { createToolbox } from '../../src/tools/index.js';
import { createSafeFetch, toFetch } from '../../src/tools/safe-fetch.js';
import { freshDb } from '../support/db.js';
import { insertUser } from '../support/fixtures.js';
import { scriptedModel } from '../support/models.js';
import { minimalSpec } from '../support/specs.js';

// Opt-in, real (tiny) money on Stellar testnet. Needs Docker Postgres and two values in this process's
// env only. Kerem runs, from apps/api:
//   set -a; source /Users/knrs/Developer/PROJECTS/agentenact/.env.testnet; set +a
//   AGENTENACT_TESTNET=1 TEST_DATABASE_URL=postgres://postgres:test@localhost:55439/agentenact_cloud_test bun test tests/e2e/runtime.testnet.test.ts
// PAYER_SECRET: a testnet account holding Circle testnet USDC (the library's e2e payer).
// OZ_API_KEY: the OpenZeppelin Channels testnet key. Neither is printed or stored.
// Real everything except the models (scripted, plan D11) and auth (no owner route is called).
const live = process.env.AGENTENACT_TESTNET === '1' && !!process.env.PAYER_SECRET && !!process.env.OZ_API_KEY;
// Built from the pinned constant at load: public data, no secret.
const USDC = new Asset('USDC', TESTNET.usdc.split(':')[1]!);
const IN = { type: 'object' as const, required: ['text'], properties: { text: { type: 'string' as const, maxLength: 500 } } };
const OUT = { type: 'object' as const, required: ['summary'], additionalProperties: false as const, properties: { summary: { type: 'string' as const } } };

describe.skipIf(!live)('runtime on Stellar testnet: paid service → hire → verify', () => {
  let sql: Db;
  let drop: (() => Promise<void>) | undefined;
  let srv: ReturnType<typeof Bun.serve> | undefined;
  let rawKeys: Keys;
  let keys: AgentKeys;
  let base = '';
  let payer: Keypair;
  const horizon = new Horizon.Server(TESTNET.horizonUrl);
  const adapter = createStellarAdapter({ network: 'testnet' });
  const events: Record<string, unknown>[] = [];
  const hires: HireOutcome[] = [];
  const seller = { userId: '', agentId: '', address: '', registryId: '' };
  const buyer = { userId: '', agentId: '', address: '', registryId: '' };
  let ownerRuns: ReturnType<typeof createOwnerRuns>;

  async function friendbotKey(): Promise<Keypair> {
    const k = Keypair.random();
    const fb = await fetch(`https://friendbot.stellar.org/?addr=${k.publicKey()}`);
    if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
    return k;
  }

  /** A real agent: key from `keys`, account + USDC trustline + stellar-8004 registration via the library's sponsor mode. */
  async function birth(into: typeof seller, name: string, sponsorKey: Keypair) {
    into.userId = await insertUser(sql);
    const [row] = (await sql`insert into app.agents (user_id, name, status) values (${into.userId}, ${name}, 'provisioning') returning id`) as { id: string }[];
    into.agentId = row!.id;
    await keys.generate(into.agentId);
    const born = await rawKeys.withSecret(into.agentId, (kp) => createStellarAgent({ network: 'stellar:testnet', sponsorSecret: sponsorKey.secret(), agentUri: `${base}/a/${into.agentId}/agent.json`, keypair: kp }));
    into.address = born.publicKey;
    into.registryId = String(born.agentId);
    await sql`update app.agents set status = 'active', stellar_address = ${born.publicKey}, agent_id = ${into.registryId} where id = ${into.agentId}`;
  }

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    rawKeys = createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });
    keys = localAgentKeys(createVault({ sql, keys: rawKeys }));
    payer = Keypair.fromSecret(process.env.PAYER_SECRET!);
    const usdc = (await horizon.loadAccount(payer.publicKey())).balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC' && b.asset_issuer === USDC.issuer);
    if (!usdc || Number(usdc.balance) < 0.012) throw new Error(`payer ${payer.publicKey()} needs >= 0.012 testnet USDC (has ${usdc?.balance ?? 0}); fund it at faucet.circle.com`);

    let app: ReturnType<typeof createApp> = async () => new Response('booting', { status: 503 });
    srv = Bun.serve({ port: 0, fetch: (req) => app(req, '127.0.0.1'), idleTimeout: 120 });
    base = `http://localhost:${srv.port}`;

    // One throwaway friendbot sponsor per agent: with a shared sponsor the second account tx stalled in the testnet
    // queue until Horizon's 504 (2026-10-14, 4 runs), though the same two creations pass back to back outside the test.
    await birth(seller, 'e2e seller', await friendbotKey());
    await birth(buyer, 'e2e buyer', await friendbotKey());

    const specs = createSpecs(sql);
    const runs = createRuns(sql);
    const memory = createMemory(sql);
    const policy = createPolicy(sql, { killSwitch: false });
    const spend = createSpend(sql);
    const log = (e: Record<string, unknown>) => void events.push(e);
    const safeFetch = createSafeFetch({ allowLoopback: true }); // the seller is local: the ONLY place allowLoopback is set; never in main.ts
    const hirer = createHirer({ keys, spend, fetch: toFetch(safeFetch, { timeoutMs: 90_000, maxBytes: 256 * 1024, maxRedirects: 0 }), runCap: (m) => BUDGETS[m].maxUsdc, log });
    const toolbox = createToolbox({
      safeFetch, memory, specs, policy,
      webhookSecret: (id) => keys.webhookSecret(id),
      mailFrom: 'AgentEnact <agents@agentenact.io>',
      env: { RESEND_API_KEY: 'unused' },
      fallbackSearch: createOpenRouterSearch({ safeFetch, env: { OPENROUTER_API_KEY: 'unused' } }), // never called: the models are scripted
      log,
      hire: async (r) => {
        const o = await hirer.hire(r);
        hires.push(o);
        return o;
      },
    });
    const agentActive = async (agentId: string) => ((await sql`select 1 from app.agents where id = ${agentId} and status = 'active'`) as unknown[]).length > 0;
    const sellerUrl = `${base}/a/${seller.agentId}/summary`;
    // The seller's service model answers with schema-valid JSON; the buyer's mission model hires the seller once, then reports.
    const serviceRunner = createServiceRunner({ runner: createRunner({ runs, policy, modelId: 'test/model', model: scriptedModel([{ text: '{"summary":"Stellar settles in seconds."}' }]) }), toolbox, agentActive });
    ownerRuns = createOwnerRuns({ sql, specs, memory, runs, runner: createRunner({ runs, policy, modelId: 'test/model', model: scriptedModel([{ tool: 'hire_agent', input: { url: sellerUrl, input: { text: 'from the buyer agent' } } }, { text: 'Hired the summary.' }]) }), toolbox, policy, log });
    const records = createRecords(sql);
    const endpoint = createServiceEndpoint({ sql, keys, specs, runs, records, runService: serviceRunner, killed: false, publicBaseUrl: base, env: { OZ_API_KEY: process.env.OZ_API_KEY }, log });
    app = createApp({ sql, verify: async () => null, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: 'https://app.agentenact.io', log, services: { endpoint, specs }, records });

    await specs.approve(seller.userId, seller.agentId, await specs.saveDraft(seller.userId, seller.agentId, minimalSpec({
      services: [{ slug: 'summary', description: 'One-sentence summary', price_usdc: '0.001', input_schema: IN, output_schema: OUT, persona: 'You summarise.', skill_body: '', tools: [] }],
    })));
    await specs.approve(buyer.userId, buyer.agentId, await specs.saveDraft(buyer.userId, buyer.agentId, minimalSpec({ tools: ['hire_agent'], hire_targets: [{ url: sellerUrl, max_usdc: '0.01' }] })));
  }, 240_000);

  afterAll(async () => {
    srv?.stop(true);
    await drop?.();
  });

  it('a buyer pays the seller service through x402 and the record verifies from public data', async () => {
    try {
      const r = await hire(`${base}/a/${seller.agentId}/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Stellar is a payments network.' }) }, {
        adapter,
        payer: { secret: process.env.PAYER_SECRET!, network: 'stellar:testnet' },
        maxAmount: '0.01',
      });
      console.log(JSON.stringify({ call: 1, status: r.response.status, tx: r.settlement?.transaction, problems: r.problems, checks: r.verification?.checks }));
      expect(r.response.status).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(r.output))).toEqual({ summary: 'Stellar settles in seconds.' });
      expect(r.verification?.checks).toEqual({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' });
      expect(r.consistent).toBe(true);
      const [run] = (await sql`select status, settlement_tx, usdc_earned::text as earned from app.runs where mode = 'service' order by started_at desc limit 1`) as { status: string; settlement_tx: string; earned: string }[];
      expect(run).toEqual({ status: 'done', settlement_tx: r.settlement!.transaction, earned: '0.0010000' });
      // The stored record is public at /a/<uuid>/records/<tx> and verifies on its own; a made-up tx under the same agent is 404.
      const stored = await fetch(`${base}/a/${seller.agentId}/records/${r.settlement!.transaction}`);
      expect(stored.status).toBe(200);
      const v = await verifyRecord(await stored.json(), adapter, { windowSeconds: 86_400 });
      expect(v.ok).toBe(true);
      expect(v.checks).toEqual({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' });
      expect((await fetch(`${base}/a/${seller.agentId}/records/${'0'.repeat(64)}`)).status).toBe(404);
    } catch (e) {
      console.log(JSON.stringify({ events }));
      throw e;
    }
  }, 180_000);

  it('the buyer agent hires the seller in a mission: 402 checked, spend settled, record consistent', async () => {
    try {
      const acc = await horizon.loadAccount(payer.publicKey());
      const fund = new TransactionBuilder(acc, { fee: '10000', networkPassphrase: TESTNET.passphrase })
        .addOperation(Operation.payment({ destination: buyer.address, asset: USDC, amount: '0.0100000' }))
        .setTimeout(60)
        .build();
      fund.sign(payer);
      const funded = await horizon.submitTransaction(fund);

      const [t] = (await sql`insert into app.triggers (agent_id, spec_version, kind, cron_expr, mission, next_run_at)
                             values (${buyer.agentId}, 1, 'cron', '0 * * * *', 'Buy a summary.', now() + interval '1 day') returning id`) as { id: string }[];
      const out = await ownerRuns.mission(buyer.agentId, t!.id, 'Buy one summary from the approved seller.');
      const h = hires.at(-1);
      console.log(JSON.stringify({ call: 2, fund: funded.hash, mission: out?.status, hire: h }));
      expect(out).toMatchObject({ status: 'done', text: 'Hired the summary.' });
      expect(h).toMatchObject({ ok: true, status: 200, consistent: true, paidUsdc: '0.0010000', output: { summary: 'Stellar settles in seconds.' } });
      const tx = (h as { transaction: string }).transaction;
      const [s] = (await sql`select decision, tx_hash, amount_usdc::text as amount, payee from app.spend where agent_id = ${buyer.agentId}`) as { decision: string; tx_hash: string; amount: string; payee: string }[];
      expect(s).toEqual({ decision: 'settled', tx_hash: tx, amount: '0.0010000', payee: seller.address });
      const [run] = (await sql`select usdc_spent::text as spent from app.runs where id = ${out!.runId}`) as { spent: string }[];
      expect(run!.spent).toBe('0.0010000');
      const paid = await adapter.readSettlement(tx);
      expect(paid.some((p) => p.payer === buyer.address && p.payee === seller.address && p.asset === TESTNET.usdc)).toBe(true);
      console.log(JSON.stringify({ seller: { agentId: seller.registryId, address: seller.address }, buyer: { agentId: buyer.registryId, address: buyer.address }, hireTx: tx }));
    } catch (e) {
      console.log(JSON.stringify({ events }));
      throw e;
    }
  }, 240_000);
});
