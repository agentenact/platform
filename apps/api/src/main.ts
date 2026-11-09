/** Wires the units and serves. Secrets are read by their units (keys, chain, loop, tools), never here. */
import { createSupabaseVerifier } from './account/auth.js';
import { createPasskeyAccount } from './account/passkey.js';
import { createSignRequests } from './account/sign-requests.js';
import { createChain } from './chain/index.js';
import { loadConfig } from './config.js';
import { createDb, dbRole, deployStamp, joinReplicas, REPLICA_JOIN_FAILED, SPONSOR_KEY, startLeadership, startLockHeartbeat } from './db/index.js';
import { createLeases } from './db/leases.js';
import { createAdvisoryCrossLock } from './chain/lock.js';
import { createRateLimiter, pruneRateWindows, setRateLimitStore } from './gateway/rate-limit.js';
import { createCommunityIndex, RECHECK_AFTER_MS, stellarTestnetCommunityVerifier } from './discovery/community.js';
import { createIntake, stellarTestnetVerifier } from './discovery/intake.js';
import { createKarma, createKarmaStore, PAYMENTS_PER_MIN } from './discovery/karma.js';
import { createDiscovery } from './discovery/queries.js';
import { exportCsv } from './discovery/export.js';
import { bootExtensions } from './extensions.js';
import { createLedger } from './loop/ledger.js';
import { createAgents } from './agents/index.js';
import { closeChainOver, createCloser } from './agents/close.js';
import { createReserves, reserveChainOver } from './agents/reserve.js';
import { createTestnetCredits, creditChainOver } from './agents/credit.js';
import { createApp, drainingResponse } from './gateway/app.js';
import { vaultClient } from './keys/rpc.js';
import { TESTNET } from './owner-client/testnet.js';
import { createShutdown, LAME_DUCK_MS, SHUTDOWN_GRACE_MS, trackStarts } from './lifecycle.js';
import { BUDGETS } from './loop/budgets.js';
import { createRunner } from './loop/index.js';
import { createServiceRunner } from './loop/service.js';
import { createModels, MODEL_IDS } from './loop/models.js';
import { createCatalog } from './loop/catalog.js';
import { createModelDirectory } from './loop/model-choices.js';
import { createOwnerRuns } from './loop/owner.js';
import { createAccessTokens } from './account/access-tokens.js';
import { createOwnerMcp } from './owner-mcp/index.js';
import { createChatLock } from './owner-mcp/chat-lock.js';
import { createOpenRouterSearch } from './loop/search.js';
import { createPolicy } from './policy/index.js';
import { createSpend } from './policy/spend.js';
import { createProvisioner } from './provision/index.js';
import { createActivity } from './activity/index.js';
import { createChecks } from './runs/checks.js';
import { createRecords } from './records/index.js';
import { createRuns } from './runs/index.js';
import { createMemory } from './runs/memory.js';
import { createScheduler } from './scheduler/index.js';
import { createSeals, sealChainOver } from './seals/index.js';
import { createChatSessions } from './chat/sessions.js';
import { createHirer } from './signer/hire.js';
import { createServiceEndpoint } from './signer/serve.js';
import { createSettlementLookup } from './signer/settlement-lookup.js';
import { createServiceMcp } from './signer/mcp.js';
import { createBuilder } from './builder/index.js';
import { createBuilderLimits } from './builder/limits.js';
import { createSuggest } from './builder/suggest.js';
import { createSkillCatalog, loadServiceSkills } from './skills/index.js';
import { createSkillSets } from './skills/sets.js';
import { createHandoffs } from './builder/handoff.js';
import { createTrial } from './builder/trial.js';
import { clientIp } from './gateway/client-ip.js';
import { safeCause } from './errors.js';
import { readPanelSecret, resolveClientIp } from './gateway/panel.js';
import { createSpecs } from './specs/index.js';
import { createToolbox } from './tools/index.js';
import { createWalletHistory } from './agents/wallet-history.js';
import { createAgentWallets } from './agents/wallets.js';
import { createAgentReads } from './tools/agents.js';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import { setIsolateLog, setIsolatePoolSize, shutdownPool } from './tools/isolate.js';
import { createSafeFetch, toFetch } from './tools/safe-fetch.js';
import { runSandboxed } from './tools/sandbox.js';

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e }));

/** How often the leader recovers what dead instances left behind. */
const RECOVERY_SWEEP_MS = 30_000;

/** Resolves once the server has no open request (a chat stream counts until it ends). Polled: Bun has no event for it. */
async function openRequests(server: { readonly pendingRequests: number }): Promise<void> {
  while (server.pendingRequests > 0) await Bun.sleep(250);
}

/** Plan D10: Bun's default idle timeout is 10 s; a chat turn may run 120 s (kept alive by SSE comments). */
const IDLE_TIMEOUT_S = 120;

setIsolateLog(log);
let stage = 'config';
try {
  // Config first: without it the process refuses to start, before any unit reads a secret.
  const config = loadConfig();
  setIsolatePoolSize(config.isolatePoolSize);
  // The first rollout over a single-replica (plan D12) instance: it yields only to a newer stamp.
  const stamp = deployStamp(process.env.SERVEL_DEPLOY_TIME, performance.timeOrigin);
  log({ event: stamp.source === 'deploy_time' ? 'deploy_stamp' : 'deploy_stamp_fallback', stamp: stamp.stamp, source: stamp.source });
  stage = 'replica';
  // Join the replica set first: the units below write this instance's id on the rows they own. Immediate next to
  // other replicas; only a single-replica (D12) holder makes this wait, for its handover (db/replica.ts).
  const session = await joinReplicas(config.databaseUrl, { stamp: stamp.stamp, log });
  const stopHeartbeat = startLockHeartbeat(session, { exit: (code) => process.exit(code), log });
  const { instance } = session;
  log({ event: 'replica_joined', instance });

  stage = 'wiring';
  const sql = createDb(config.databaseUrl);
  // Every named rate limiter built from here on counts in Postgres, shared by the replicas.
  setRateLimitStore(sql);
  const leases = createLeases(sql, instance);
  const sponsorCross = createAdvisoryCrossLock(config.databaseUrl, SPONSOR_KEY, log);
  void dbRole(sql).then(
    (r) => log({ event: 'db_role', ...r }),
    () => log({ event: 'db_role', error: 'check_failed' }),
  );
  // ONE WebAuthn identity for both sides: the origins the passkey unit accepts at registration are the
  // origins the chain kit is configured with. The rp id is one value everywhere (agentenact.io); the origin
  // is a list (APP_ORIGINS) because it is only an off-chain check: the on-chain WebAuthn verifier ignores
  // clientDataJSON.origin, and nothing stored per wallet records it.
  const webauthn = { rpId: config.rpId, origin: config.appOrigin, origins: config.appOrigins } as const;
  // Agent keys live in the vault (src/vault-main.ts); this process holds only its URL and bearer token.
  const keys = vaultClient();
  // With SPONSOR_PUBLIC_KEY set, the vault signs for the sponsor too (chain reads which applies).
  const chain = createChain({ ...webauthn, remoteSponsor: (publicKey) => keys.sponsorSigner(publicKey), crossLock: sponsorCross });
  if (chain.sponsorIsRemote) {
    void keys.sponsorPublicKey().then(
      (held) => held !== chain.sponsorPublicKey && log({ event: 'sponsor_mismatch', configured: chain.sponsorPublicKey, vault: held }),
      () => log({ event: 'sponsor_unreachable' }),
    );
  }
  // The validity bound reads the ledger from the same RPC the soroban seam (and so the library) uses.
  const signRequests = createSignRequests(sql, { source: chain.sponsorPublicKey, latestLedger: () => chain.soroban.latestLedger!(), instance });
  const base = createProvisioner({ sql, keys, chain, signRequests, publicBaseUrl: config.publicBaseUrl, log, limits: { live: config.agentLimit, sponsoredStartsPerDay: config.sponsoredStartsPerDay }, leases, instance, feeModel: config.feeModel });
  const provisioner = trackStarts(base); // shutdown waits for the starts it launched

  // P3a runtime. createModels and createToolbox throw on a missing key, so the boot fails fast.
  // The kill switch is RUNTIME_KILL_SWITCH plus whatever stop an extension adds (extensions.ts); every consumer reads `policy.killed` at use time.
  const extensions = bootExtensions(sql, { env: config.killSwitch, log });
  const killSwitch = extensions.killSwitch;
  await killSwitch.load(); // fails closed: if the stored state cannot be read the boot aborts (servel keeps the previous version)
  const stopKillSwitch = killSwitch.start();
  const policy = createPolicy(sql, { killSwitch: () => killSwitch.on });
  const specs = createSpecs(sql);
  const runs = createRuns(sql, { instance });
  const records = createRecords(sql);
  const checks = createChecks(sql);
  const memory = createMemory(sql);
  const webhookSecret = (agentId: string) => keys.webhookSecret(agentId);
  const models = createModels();
  // What an owner may pick for one agent: the curated models and the OpenRouter catalog (loop/model-choices.ts).
  const modelDirectory = { ...createModelDirectory({ defaultId: MODEL_IDS.run, catalog: createCatalog() }), defaultId: MODEL_IDS.run };
  const ledger = createLedger(sql, { log });
  const safeFetch = createSafeFetch();
  const spend = createSpend(sql, { instance });
  // Plan D7: no redirects, 90 s (the seller's 60 s handler + settle), 256 KB. Never allowLoopback here (tests only).
  const hirer = createHirer({ keys, spend, fetch: toFetch(safeFetch, { timeoutMs: 90_000, maxBytes: 256 * 1024, maxRedirects: 0 }), runCap: (mode) => BUDGETS[mode].maxUsdc, log });
  // Per-agent payments and scores for /public/agents come from AgentKarma (one background refresh, never per request).
  // The leader pulls it and saves it to app.karma_snapshot; the other replicas load that (never AgentKarma themselves).
  const karmaPayments = createRateLimiter({ name: 'karma.payments', limit: PAYMENTS_PER_MIN, windowMs: 60_000 });
  const karma = createKarma({ log, store: createKarmaStore(sql), paymentsBudget: () => karmaPayments.hit('all') });
  const discovery = createDiscovery(sql, { karma });
  const agentReads = createAgentReads({
    discovery,
    agentUri: async (id) => ((await sql`select uri from discovery.agents where agent_id = ${id}`) as { uri: string }[])[0]?.uri ?? null,
    // An agent's registration document: no redirects, 5 s, 64 KB (the library's own cap).
    fetch: toFetch(safeFetch, { timeoutMs: 5_000, maxBytes: 64 * 1024, maxRedirects: 0 }),
    adapter: createStellarAdapter({ network: 'testnet' }),
  });
  const toolbox = createToolbox({ safeFetch, memory, specs, policy, webhookSecret, mailFrom: config.mailFrom, appOrigin: config.appOrigin, fallbackSearch: createOpenRouterSearch({ safeFetch }), log, hire: (r) => hirer.hire(r), agents: agentReads });
  const runner = createRunner({
    runs, policy, model: models.run, modelId: MODEL_IDS.run, ledger, chat: models.chat, models: modelDirectory,
    // The owner's pick for this agent (app.agents.model); the runner checks it against loop/model-choices.ts.
    modelFor: async (agentId) => ((await sql`select model from app.agents where id = ${agentId}`) as { model: string | null }[])[0]?.model ?? null,
  });
  const agentActive = async (agentId: string) => ((await sql`select 1 from app.agents where id = ${agentId} and status = 'active'`) as unknown[]).length > 0;
  const serviceRunner = createServiceRunner({ runner, toolbox, agentActive, serviceSkills: (agentId, names) => loadServiceSkills(sql, agentId, names) });
  const readTx = toFetch(safeFetch, { timeoutMs: 5_000, maxBytes: 256 * 1024, maxRedirects: 0 });
  const findSettlement = createSettlementLookup({
    payments: (a) => toolbox.stellarPayments(a),
    envelope: async (tx) => {
      const res = await readTx(`${TESTNET.horizonUrl}/transactions/${tx}`);
      if (!res.ok) throw new Error(`horizon ${res.status}`);
      return ((await res.json()) as { envelope_xdr: string }).envelope_xdr;
    },
  });
  const endpoint = createServiceEndpoint({ sql, keys, specs, runs, records, runService: serviceRunner, get killed() { return policy.killed; }, publicBaseUrl: config.publicBaseUrl, leases, findSettlement, log });
  // The agent's own addresses go into its owner-run context ("what you have been doing").
  const ownAddresses = async (agentId: string) => {
    const [stellar, evm, solana] = await Promise.all([keys.publicKey(agentId), keys.evmAddress(agentId), keys.solanaAddress(agentId)]);
    return [
      ...(stellar ? [{ network: 'stellar:testnet', address: stellar }] : []),
      ...(evm ? [{ network: 'eip155 (Base Sepolia, Arbitrum Sepolia, Avalanche Fuji, Polygon Amoy: one address)', address: evm }] : []),
      ...(solana ? [{ network: 'solana:devnet', address: solana }] : []),
    ];
  };
  // A mission's mail waits (briefly) for its decision seal, so the mail carries the transaction (seals is made just below).
  const owner = createOwnerRuns({
    sql, specs, memory, runs, runner, toolbox, policy, log, addresses: ownAddresses, appOrigin: config.appOrigin,
    ...(config.checkSeals ? { seals: { enqueueDecision: (a, x) => seals.enqueueDecision(a, x), decisions: (a, ids) => seals.decisions(a, ids) } } : {}),
  });
  // One owner conversation per agent, whether it comes from the panel chat or a harness over the owner MCP.
  const chatLock = createChatLock(leases);
  const agentsPanel = createAgents(sql, { feeModel: config.feeModel, models: modelDirectory });
  // The panel's wallet card: the agent's own addresses per network, with a public USDC read each.
  const agentWallets = createAgentWallets({ sql, keys, balance: (a) => toolbox.walletBalance(a) });
  // Every condition check sealed on chain: the check only queues its seal; the worker lands it (seals/index.ts).
  const seals = createSeals({ sql, chain: sealChainOver(chain), signSeal: (a, x, p) => keys.signSeal(a, x, p), killed: () => policy.killed, log });
  // Owner chat conversations kept on the server; the seal worker puts each one's Merkle root on chain.
  const chatSessions = createChatSessions(sql, { log, seals: config.checkSeals });
  // A deleted agent's wallets: emptied to its owner and closed, then its key destroyed (agents/close.ts).
  // Agents buy their own reserves at their first funding (all of them under FEE_MODEL=agent, extra ones under sponsor) and
  // a self-paying agent its fee float; deleting one returns its reserves to its owner (agents/reserve.ts).
  const reserves = createReserves({ sql, chain: reserveChainOver(chain), keys, feeModel: config.feeModel, killed: () => policy.killed, log });
  // TESTNET_CREDIT=on: the sponsor keeps 1 testnet USDC in each live agent's wallet so hire_agent can pay (agents/credit.ts).
  const credits = config.testnetCredit ? createTestnetCredits({ sql, chain: creditChainOver(chain), keys, killed: () => policy.killed, log }) : null;
  const closer = createCloser({
    sql,
    chain: closeChainOver(chain),
    keys,
    evmBalance: (a) => toolbox.walletBalance(a),
    responsor: (a, x) => reserves.responsor(a, x),
    killed: () => policy.killed,
    log,
  });
  const activity = createActivity(sql, { publicBaseUrl: config.publicBaseUrl, seals, models: modelDirectory });
  const tokens = createAccessTokens(sql);
  const scheduler = createScheduler({
    sql,
    killed: () => policy.killed,
    mission: async (agentId, triggerId, text) => {
      // The decision and what it paid for are sealed on Stellar inside owner.mission, once the run has ended.
      return owner.mission(agentId, triggerId, text);
    },
    conditionFetch: (agentId, tool, args, signal) => toolbox.conditionFetch(agentId, tool, args, signal),
    sandbox: runSandboxed,
    notify: (agentId, text) => owner.notify(agentId, text),
    recordCheck: (agentId, kind) => checks.record(agentId, kind),
    logCheck: async (agentId, e) => {
      await checks.log(agentId, e);
      if (config.checkSeals) await seals.enqueue(agentId, { held: e.held, reading: e.reading });
    },
    pruneChecks: () => checks.prune(),
    log,
  });

  stage = 'construct';
  const mounted = extensions.mount({
    sql,
    config,
    log,
    karma,
    sponsorPublicKey: chain.sponsorPublicKey,
    mail: (to, subject, text, key) => toolbox.delivery.email(to, subject, text, key),
    startedAt: new Date(),
  });
  const community = createCommunityIndex({ sql, verifier: stellarTestnetCommunityVerifier(), log });
  // GITHUB_TOKEN (optional, read-only public repo access) lifts GitHub's unauthenticated 60 requests/hour.
  const skillsDeps = () => {
    const catalog = createSkillCatalog({ sql, ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}) });
    return { catalog, sets: createSkillSets({ sql, catalog }) };
  };
  const app = createApp({
    agentLimits: { live: config.agentLimit, perDay: config.agentCreationsPerDay },
    feeModel: config.feeModel,
    extraRoutes: mounted.routes,
    sql,
    verify: createSupabaseVerifier({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey }),
    passkey: createPasskeyAccount({ sql, chain, ...webauthn }),
    signRequests,
    provisioner,
    appOrigin: config.appOrigin,
    appOrigins: config.appOrigins,
    log,
    runtime: {
      specs, runs, chat: owner, webhookSecret, chatLock, chatSessions,
      // A chat turn that paid is a decision with money behind it: sealed at once, like a mission's.
      sealPaidTurn: async (agentId, t) => (config.checkSeals ? seals.enqueueDecision(agentId, t) : undefined),
      get killed() { return policy.killed; },
    },
    tokens,
    ownerMcp: createOwnerMcp({
      sql,
      tokens,
      activity,
      runs,
      chat: owner,
      chatLock,
      agents: agentsPanel,
      specs,
      reads: agentReads,
      hire: (r) => hirer.hire(r),
      killed: () => policy.killed,
      publicBaseUrl: config.publicBaseUrl,
      version: '1',
      log,
    }),
    services: {
      endpoint,
      specs,
      mcp: createServiceMcp({
        agent: async (id) => ((await sql`select name, status from app.agents where id = ${id}`) as { name: string; status: string }[])[0] ?? null,
        specs,
        endpoint,
        version: '1',
      }),
    },
    discovery: { discovery, sealBySignature: (sig) => seals.bySignature(sig), exportCsv: (name, o) => exportCsv(sql, name, o), intake: createIntake({ sql, verifier: stellarTestnetVerifier(), usdc: TESTNET.usdc, log }), community, log },
    records,
    panel: { agents: agentsPanel, models: modelDirectory, killed: () => policy.killed, closer, activity, wallets: agentWallets, history: createWalletHistory({ sql, keys, safeFetch, stellarPayments: (a) => toolbox.stellarPayments(a), seals }), revise: { builder: createBuilder({ models, ledger }), limits: createBuilderLimits(sql), specs, get killed() { return policy.killed; } }, suggest: { suggest: createSuggest({ sql, specs, checks, model: models.run, limits: createBuilderLimits(sql), ledger }), get killed() { return policy.killed; } } },
    skills: skillsDeps(),
    builder: { builder: createBuilder({ models, ledger }), trial: createTrial({ model: models.run, toolbox, sandbox: runSandboxed, ledger }), trialAnon: createTrial({ model: models.builderAnon, toolbox, sandbox: runSandboxed, ledger }), handoffs: createHandoffs(sql), limits: createBuilderLimits(sql), get killed() { return policy.killed; } },
  });
  await sql`select 1`; // pool warm-up

  stage = 'serve';
  // The visitor address: the web panel's forwarded one when it proves itself, else the Cloudflare-aware one, else the socket's.
  const panelSecret = readPanelSecret();
  let ready = true; // false from SIGTERM: /health answers 503 while other requests are still served (lame duck)
  let draining = false; // set after the lame duck: new requests get 503 while open ones finish
  // maxRequestBodySize: Bun itself answers 413 for bodies over 128 KB, before the app sees them
  // (that response carries no CORS headers). The app's own 64 KB limit answers 413 below that.
  const server = Bun.serve({
    port: config.port,
    fetch: (req, srv) => {
      const path = new URL(req.url).pathname;
      if (draining || (!ready && path === '/health')) return drainingResponse(path);
      return app(req, resolveClientIp(req, clientIp(req, srv.requestIP(req)?.address), panelSecret));
    },
    maxRequestBodySize: 128 * 1024,
    idleTimeout: IDLE_TIMEOUT_S,
  });

  // Every replica serves the AgentKarma snapshot the leader saved, until it leads itself.
  let stopKarma = karma.follow();
  /**
   * Rows a dead instance left behind (runs `running`, spend `reserved`, sign requests pending, provisions `creating`)
   * and dead leases. Only the leader sweeps, on taking over and every RECOVERY_SWEEP_MS; a live replica's rows are
   * never touched (app.instance_alive).
   */
  const recover = async () => {
    try {
      const swept = {
        expired: await signRequests.expireOrphaned(),
        recovered: await base.recoverInterrupted(),
        // Runs a dead process left `running` become error/interrupted, so their usage is never lost (plan D18).
        interruptedRuns: await runs.failInterrupted(),
        interruptedSpend: await spend.recoverInterrupted(), // plan D13
        leases: await leases.sweep(),
        rateWindows: await pruneRateWindows(sql),
        // Deleted agents: wallets still to close, private content due to be cleared.
        closes: await closer.tick(),
        // Agents whose first funding arrived: their reserves move off the sponsor; self-paying ones low on XLM buy a float.
        reserves: await reserves.tick(),
        // Live agents low on testnet USDC get 1 from the sponsor (off unless TESTNET_CREDIT=on).
        credits: credits ? await credits.tick() : null,
        // Whatever the build's extensions run on the tick (extensions.ts).
        ...(await mounted.tick()),
      };
      if (swept.expired || swept.recovered || swept.interruptedRuns || swept.interruptedSpend) log({ event: 'recovered', ...swept });
    } catch (e) {
      log({ event: 'recovery_failed', ...safeCause(e) });
    }
  };
  let stopLeaderJobs = () => undefined as void;
  const stopLeadership = startLeadership(session, {
    log,
    onLead: () => {
      stopKarma();
      void recover();
      const stopScheduler = scheduler.start();
      // Check and decision seals: one worker, on the leader (the queue's leases would also keep two apart).
      const stopSeals = config.checkSeals ? seals.start() : () => undefined;
      stopKarma = karma.start();
      // Community anchors: a moved or removed anchor unlists its template within about RECHECK_AFTER_MS.
      const recheckTimer = setInterval(() => void community.recheck().catch(() => log({ event: 'community_recheck_failed' })), RECHECK_AFTER_MS / 3);
      const sweepTimer = setInterval(() => void recover(), RECOVERY_SWEEP_MS);
      stopLeaderJobs = () => {
        stopScheduler();
        stopSeals();
        clearInterval(recheckTimer);
        clearInterval(sweepTimer);
      };
    },
  });

  const shutdown = createShutdown({
    // Out of rotation, still serving. The leader's jobs stop now, and leadership passes on as soon as the scheduler's
    // running tick is done (or SHUTDOWN_GRACE_MS), so another replica picks the jobs up during the lame duck.
    unready: () => {
      ready = false;
      stopLeadership();
      stopLeaderJobs();
      stopKarma();
      void Promise.race([Promise.allSettled([...scheduler.inflight(), ...seals.inflight()]), Bun.sleep(SHUTDOWN_GRACE_MS)]).then(() => session.stepDown());
    },
    lameDuckMs: LAME_DUCK_MS,
    // Drain only. Bun 1.3.11: server.stop() resolves only after open streams finish (a chat can stream
    // 120 s), and a later server.stop(true) does NOT force-close after it (measured). So the one real
    // stop is forceStop below; until then new requests get 503 and open ones may finish.
    stop: () => {
      draining = true;
      endpoint.drain(); // calls still in their handler end with nothing settled
      stopKillSwitch();
    },
    // After the grace wait: close the listener and every open connection (aborts request signals, so chat runs end).
    forceStop: () => server.stop(true),
    // The scheduler's running tick (SHUTDOWN_GRACE_MS). A tick can outlast the grace: missions are NOT aborted. The
    // 25-minute lease plus the next leader's recovery make the trigger fire again (at-least-once).
    inflight: () => [...scheduler.inflight(), ...seals.inflight()],
    // Up to CRITICAL_GRACE_MS: a paid call already settling (drain() aborted the rest, nothing settled), provision
    // starts, and every open response (chat streams): another replica already takes the new requests.
    critical: () => [...provisioner.inflight(), ...endpoint.inflight(), openRequests(server)],
    stopTools: shutdownPool,
    closeDb: async () => {
      await sql.close();
      await sponsorCross.close();
    },
    release: async () => {
      stopHeartbeat();
      await session.release();
    },
    exit: (code) => process.exit(code),
    log,
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  log({ event: 'listening', port: config.port, instance, sponsor: chain.sponsorPublicKey, sponsorInVault: chain.sponsorIsRemote, killSwitch: config.killSwitch, checkSeals: config.checkSeals });
} catch (e) {
  // A fixed event: never the error object (it may carry a URL or a secret). Config, lock and unit-key
  // messages are fixed words (variable names, never values), so they are safe to name.
  const message = (e as Error | null)?.message;
  const fixed = typeof message === 'string' && /^(config|loop|tools|keys|chain|signer): [A-Z_]+ (is not set|must be)/.test(message);
  const reason = fixed ? message : stage === 'replica' && message === REPLICA_JOIN_FAILED ? message : undefined;
  log({ event: 'startup_failed', stage, ...(reason ? { reason } : {}) });
  process.exit(1);
}
