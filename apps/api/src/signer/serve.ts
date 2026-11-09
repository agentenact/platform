/**
 * The paid service endpoint (spec §5.6): POST /a/:agentUuid/:slug.
 * 1. Before payment: agent `active` AND service `live` (404; specs.service() filters neither, so both are
 *    checked here: P3a carry-forward), kill switch (503), body ≤ 64 KB (413), JSON (400), the input schema
 *    (400). Validation reads req.clone(); the library reads the original (plan D2).
 * 2. The unpaid probe gets 402 PAYMENT-REQUIRED from a cached X402Server, built from the agent's address
 *    only; the key is not opened (plan D1).
 * 3. A paid call (draining, or 4 in flight: 503 before verify) builds createEnactServer with a remote record
 *    signer: the agent key stays in the vault, which signs this agent's record once per settlement. The
 *    library re-checks the signed record; a signing failure after settle is 500 record_failed WITH the settlement.
 *    Library order: verify → our handler (service run, 30 s abort) → settle → sign → send;
 *    handlerTimeoutMs is 60 s (gate 2). The owner's user id comes from the agent's row.
 * 4. After the library returned: record the settlement on the run and store the returned Enactment Record
 *    (both fenced; failures only logged). They run side by side under ONE 2 s bound, so the paid response waits
 *    at most 2 s for the two together.
 * A library throw after our handler ran (e.g. a facilitator transport error in settle) leaves the money
 * state unknown. The payment is then looked for on chain (settlement-lookup.ts): found, the call completes as if the
 * answer had come; not found, 502 settlement_unknown, logged with the run id.
 * Shutdown (plan D12): every paid call is tracked (`inflight`). `drain()` stops admitting paid calls and
 * aborts those still in their handler (nothing settled, the buyer keeps their money). A call whose handler
 * returned is `settling`: nothing of ours aborts it, and the shutdown waits for it.
 */
import { createHash } from 'node:crypto';
import { decodePaymentResponseHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { decodeRecordHeader, ENACTMENT_HEADER, type ChainAdapter, type RecordSkill } from 'agentenact';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import { createEnactServer, createX402Server, type X402Server } from 'agentenact/serve';
import { DELEGATION_HEADER, checkIncomingDelegation } from 'agentenact/orchestrate';
import type { Db } from '../db/index.js';
import { createMemoryLeases, type Leases } from '../db/leases.js';
import { safeCause } from '../errors.js';
import type { AgentKeys } from '../keys/rpc.js';
import type { Records } from '../records/index.js';
import type { Runs } from '../runs/index.js';
import type { ServiceRow, Specs } from '../specs/index.js';
import { validate } from '../specs/json-schema.js';
import type { FindSettlement } from './settlement-lookup.js';
import { unitsToUsdc } from './usdc.js';

export const SERVICE_NETWORK = 'stellar:testnet' as const;
export const FACILITATOR_TESTNET_URL = 'https://channels.openzeppelin.com/x402/testnet';
export const SERVICE_TIMEOUT_MS = 30_000;
export const HANDLER_TIMEOUT_MS = 60_000;
export const SETTLE_RECORD_TIMEOUT_MS = 2_000;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_CONCURRENT_PAID = 4;
/** Longer than a buyer's signed auth entry lives (x402 maxTimeoutSeconds, 300 s); only bounds a holder that never releases. */
export const PAID_LEASE_MS = 10 * 60_000;
/** Deepest hire chain a paid service accepts (AgentEnact-Delegation depth). Hosted services cannot hire further. */
export const DELEGATION_MAX_DEPTH = 4;
export const PUBLIC_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Enactment-Record, Retry-After',
};

/** `skills`: set for a service the owner gave skills; the record is then v0.2 and names them (loop/service.ts). */
export type ServiceRunner = (svc: ServiceRow, ownerUserId: string, input: unknown, signal: AbortSignal) => Promise<{ runId: string; output: unknown; skills?: RecordSkill[] }>;
export type X402Factory = (o: { payTo: string; price: string; resource: string; description: string }) => Promise<X402Server>;

export interface ServeDeps {
  sql: Db;
  keys: Pick<AgentKeys, 'recordSigner' | 'publicKey'>;
  specs: Pick<Specs, 'service'>;
  runs: Pick<Runs, 'settle'>;
  records: Pick<Records, 'save'>;
  runService: ServiceRunner;
  killed: boolean;
  publicBaseUrl: string;
  env?: Record<string, string | undefined>;
  x402Factory?: X402Factory;
  adapter?: ChainAdapter;
  serviceTimeoutMs?: number;
  handlerTimeoutMs?: number;
  maxConcurrent?: number;
  /** One copy of a payment signature in flight across replicas (db/leases.ts). Absent: this process only. */
  leases?: Leases;
  /** Looks for a payment whose settle call threw (settlement-lookup.ts). Absent: the call answers settlement_unknown. */
  findSettlement?: FindSettlement;
  log?: (e: Record<string, string | number>) => void;
}

export interface ServiceEndpoint {
  handle(req: Request, agentUuid: string, slug: string): Promise<Response>;
  resourceUrl(agentUuid: string, slug: string): string;
  /** Stops admitting paid calls and aborts those still in their handler (nothing settled). Calls already settling are left alone. */
  drain(): void;
  /** Paid calls in flight: each settles once its response is built and the run's settlement is recorded. For the shutdown wait. */
  inflight(): Promise<unknown>[];
}

/** The HTTP status in the error a facilitator answer becomes. Only the number: its words can hold anything. */
export function facilitatorStatus(e: unknown): { errStatus?: number } {
  const m = e instanceof Error ? /^Facilitator \w+ failed \((\d{3})\)/.exec(e.message) : null;
  return m ? { errStatus: Number(m[1]) } : {};
}

/** '0.0100000' → '0.01': the x402 price string ($ added by the library). */
export const priceOf = (priceUsdc: string) => priceUsdc.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

interface AgentRow {
  user_id: string;
  status: string;
  stellar_address: string | null;
  agent_id: string | null;
}

/** One paid call in flight. `settling` turns true when our handler returned: from there the library settles. */
interface Flight {
  stop: AbortController;
  settling: boolean;
}

export function createServiceEndpoint(d: ServeDeps): ServiceEndpoint {
  const env = d.env ?? process.env;
  const apiKey = env.OZ_API_KEY;
  if (!apiKey) throw new Error('signer: OZ_API_KEY is not set');
  const facilitator = { url: FACILITATOR_TESTNET_URL, apiKey };
  const adapter = d.adapter ?? createStellarAdapter({ network: 'testnet' });
  // A throwing logger must never break a response, least of all after money moved.
  const log = (e: Record<string, string | number>) => {
    try {
      d.log?.(e);
    } catch {
      // logging is best effort
    }
  };
  const factory: X402Factory =
    d.x402Factory ??
    ((o) =>
      // createX402Server reads only agent.address (library src/serve.ts): no secret is held here.
      createX402Server({ network: SERVICE_NETWORK, agent: { address: o.payTo, secret: new Uint8Array(0) }, price: o.price, facilitator, resource: o.resource, description: o.description }));
  const maxConcurrent = d.maxConcurrent ?? MAX_CONCURRENT_PAID;
  const cache = new Map<string, Promise<X402Server>>();
  const flights = new Set<Flight>();
  const tracked = new Set<Promise<unknown>>();
  // sha256(PAYMENT-SIGNATURE) of the paid calls in flight. Until the first copy settles, verify passes for every copy.
  const sigsInFlight = new Set<string>();
  const leases = d.leases ?? createMemoryLeases();
  let active = 0;
  let draining = false;

  const resourceUrl = (agentUuid: string, slug: string) => `${d.publicBaseUrl}/a/${agentUuid}/${slug}`;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...PUBLIC_HEADERS, 'content-type': 'application/json' } });

  /** The call's server: a settle call that throws looks for the payment on chain before it counts as unknown. */
  function withLookup(x402: X402Server, payTo: string, svc: ServiceRow, find: FindSettlement): X402Server {
    let payer = '';
    return {
      ...x402,
      async verify(header) {
        const v = await x402.verify(header);
        if (v.ok) payer = v.payer;
        return v;
      },
      async settle(payload, requirements) {
        try {
          return await x402.settle(payload, requirements);
        } catch (e) {
          const transaction = await find({ payload, payer, payTo, units: requirements.amount }).catch(() => null);
          if (!transaction) throw e;
          log({ event: 'settlement_recovered', service: svc.id, tx: transaction, ...safeCause(e), ...facilitatorStatus(e) });
          const responseHeader = encodePaymentResponseHeader({ success: true, transaction, network: SERVICE_NETWORK, payer, amount: requirements.amount });
          return { ok: true as const, transaction, payer, amount: unitsToUsdc(requirements.amount), responseHeader };
        }
      },
    };
  }

  function serverFor(svc: ServiceRow, payTo: string, agentUuid: string): Promise<X402Server> {
    const key = `${svc.id}:${svc.updatedAt.getTime()}:${payTo}`;
    let p = cache.get(key);
    if (!p) {
      for (const k of cache.keys()) if (k.startsWith(`${svc.id}:`)) cache.delete(k);
      p = factory({ payTo, price: priceOf(svc.priceUsdc), resource: resourceUrl(agentUuid, svc.slug), description: svc.description });
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  }

  async function paidCall(req: Request, svc: ServiceRow, agent: AgentRow, agentUuid: string, input: unknown, x402: X402Server, flight: Flight): Promise<Response> {
    const address = agent.stellar_address!; // checked by handle()
    let runId: string | undefined;
    let res: Response;
    try {
      // Before verify: the vault must hold this agent's live key, or the record could not be signed after settle.
      if ((await d.keys.publicKey(agentUuid)) !== address) throw new Error('signer: no live key');
      const enact = await createEnactServer({
        network: SERVICE_NETWORK,
        agent: { address, ...(agent.agent_id ? { agentId: agent.agent_id } : {}), signRecord: d.keys.recordSigner(agentUuid) },
        adapter,
        price: priceOf(svc.priceUsdc),
        facilitator,
        resource: resourceUrl(agentUuid, svc.slug),
        description: svc.description,
        x402: d.findSettlement ? withLookup(x402, address, svc, d.findSettlement) : x402,
        handlerTimeoutMs: d.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS,
        handler: async () => {
          // Drain safety must not depend on the runner honouring the signal: a drain during verify stops here, before settle.
          if (flight.stop.signal.aborted) throw new Error('signer: draining');
          const signal = AbortSignal.any([flight.stop.signal, AbortSignal.timeout(d.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS)]);
          const out = await d.runService(svc, agent.user_id, input, signal);
          runId = out.runId;
          flight.settling = true; // from here the library settles: drain() leaves this call alone
          // A service the owner gave skills signs a v0.2 record naming the approved skills in this run's instructions.
          return { body: new TextEncoder().encode(JSON.stringify(out.output)), mediaType: 'application/json', ...(out.skills ? { skills: out.skills } : {}) };
        },
      });
      res = await enact(req);
    } catch (e) {
      if (runId) {
        log({ event: 'settlement_unknown', service: svc.id, run: runId, ...safeCause(e), ...facilitatorStatus(e) });
        return json(502, { error: 'settlement_unknown' });
      }
      log({ event: 'service_unavailable', service: svc.id, ...safeCause(e) });
      return json(503, { error: 'unavailable' });
    }

    // Nothing below may throw: money may have moved, and the response carries the settlement.
    try {
      const paid = res.headers.get('PAYMENT-RESPONSE');
      if (paid) {
        let tx = '';
        try {
          const s = decodePaymentResponseHeader(paid);
          tx = typeof s.transaction === 'string' ? s.transaction : '';
          if (s.success && /^[0-9a-f]{64}$/.test(tx)) {
            // Bounded: the paid response must not wait on a slow DB. The writes may still complete after the timeout.
            // One timer for both writes, so the response never waits longer than SETTLE_RECORD_TIMEOUT_MS in all.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = Symbol('timeout');
            const deadline = new Promise<typeof timedOut>((r) => (timer = setTimeout(() => r(timedOut), SETTLE_RECORD_TIMEOUT_MS)));
            const recordHeader = res.headers.get(ENACTMENT_HEADER);
            const settleRun = async () => {
              if (!runId) return;
              try {
                const recorded = await Promise.race([d.runs.settle(runId, tx, svc.priceUsdc), deadline]);
                if (recorded === timedOut) log({ event: 'settlement_record_timeout', service: svc.id, run: runId });
                else if (!recorded) log({ event: 'settlement_not_recorded', service: svc.id, run: runId, tx });
              } catch {
                log({ event: 'settlement_record_failed', service: svc.id, run: runId });
              }
            };
            // The stored record is a copy of the header the library already built; a missing or bad header only logs.
            const storeRecord = async () => {
              if (!recordHeader) return;
              try {
                const saved = await Promise.race([d.records.save(agentUuid, runId ?? null, tx, decodeRecordHeader(recordHeader)), deadline]);
                if (saved === timedOut) log({ event: 'record_store_timeout', service: svc.id, ...(runId ? { run: runId } : {}) });
                else if (!saved) log({ event: 'record_store_refused', service: svc.id, ...(runId ? { run: runId } : {}) });
              } catch {
                log({ event: 'record_store_failed', service: svc.id, ...(runId ? { run: runId } : {}) });
              }
            };
            try {
              await Promise.all([settleRun(), storeRecord()]);
            } finally {
              clearTimeout(timer);
            }
          }
        } catch {
          log({ event: 'settlement_record_failed', service: svc.id, ...(runId ? { run: runId } : {}) });
        }
        // Traefik replaces 5xx bodies at the edge; the tx hash survives here and in the PAYMENT-RESPONSE header.
        if (res.status !== 200) log({ event: 'paid_without_output', service: svc.id, status: res.status, ...(tx ? { tx } : {}) });
        if (draining) log({ event: 'paid_call_during_drain', service: svc.id, ...(tx ? { tx } : {}) });
      }
      for (const [k, v] of Object.entries(PUBLIC_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
    } catch {
      log({ event: 'post_settle_fenced', service: svc.id });
    }
    return res;
  }

  return {
    resourceUrl,

    drain() {
      draining = true;
      for (const f of flights) if (!f.settling) f.stop.abort();
    },

    inflight: () => [...tracked],

    async handle(req, agentUuid, slug) {
      const agent = ((await d.sql`select user_id, status, stellar_address, agent_id from app.agents where id = ${agentUuid}`) as AgentRow[])[0];
      const svc = agent ? await d.specs.service(agentUuid, slug) : null;
      if (!agent || agent.status !== 'active' || !agent.stellar_address || !svc || svc.status !== 'live') return json(404, { error: 'not_found' });
      if (d.killed) return json(503, { error: 'killed' });
      // runs.settle throws on a bad amount, and it runs after money moved: refuse a malformed price before any payment.
      if (!/^\d{1,12}(\.\d{1,7})?$/.test(svc.priceUsdc) || Number(svc.priceUsdc) <= 0) {
        log({ event: 'bad_service_price', service: svc.id });
        return json(503, { error: 'unavailable' });
      }

      if (Number(req.headers.get('content-length') ?? '0') > MAX_INPUT_BYTES) return json(413, { error: 'too_large' });
      const bytes = new Uint8Array(await req.clone().arrayBuffer());
      if (bytes.byteLength > MAX_INPUT_BYTES) return json(413, { error: 'too_large' });
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json(400, { error: 'bad_json' });
      }
      const bad = validate(svc.inputSchema, input);
      if (bad !== null) return json(400, { error: 'bad_input', path: bad });
      // A hire chain that already paid this agent (A → B → A) or runs too deep is refused before the 402 and before
      // verify, so nothing is signed or settled. The header is advisory: absent means a direct call.
      const chain = checkIncomingDelegation(req.headers.get(DELEGATION_HEADER), { self: agent.stellar_address, maxDepth: DELEGATION_MAX_DEPTH });
      if (!chain.ok) return json(chain.reason === 'bad_delegation' ? 400 : 508, { error: chain.reason });

      let x402: X402Server;
      try {
        x402 = await serverFor(svc, agent.stellar_address, agentUuid);
      } catch (e) {
        log({ event: 'x402_init_failed', service: svc.id, ...safeCause(e) });
        return json(503, { error: 'payments_unavailable' });
      }
      if (!req.headers.get('PAYMENT-SIGNATURE')) {
        try {
          const pr = await x402.paymentRequired();
          return new Response(pr.body, { status: 402, headers: { ...PUBLIC_HEADERS, 'content-type': 'application/json', ...pr.headers } });
        } catch (e) {
          log({ event: 'payment_required_failed', service: svc.id, ...safeCause(e) });
          return json(503, { error: 'payments_unavailable' });
        }
      }

      // One payment signature runs once: a copy arriving while the first is in flight is refused before verify, before the key
      // is opened and before a slot is taken. A finished signature is refused by the facilitator or the chain: no long-term set.
      const sigHash = createHash('sha256').update(req.headers.get('PAYMENT-SIGNATURE')!).digest('hex');
      if (sigsInFlight.has(sigHash)) return json(409, { error: 'payment_in_flight' });
      // No await between the checks and the increment: the cap cannot be raced.
      if (draining || active >= maxConcurrent) return json(503, { error: 'busy' });
      sigsInFlight.add(sigHash);
      active++;
      const flight: Flight = { stop: new AbortController(), settling: false };
      flights.add(flight);
      let release: (() => Promise<void>) | null = null;
      const call: Promise<Response> = (async () => {
        // The same signature on another replica: the lease is shared (db/leases.ts). Taken after the local slot, so the
        // cap above stays race-free; a refusal here gives the slot back in the finally below.
        try {
          release = await leases.take(`paid:${sigHash}`, PAID_LEASE_MS);
        } catch (e) {
          log({ event: 'paid_lease_failed', service: svc.id, ...safeCause(e) });
          return json(503, { error: 'busy' });
        }
        if (!release) return json(409, { error: 'payment_in_flight' });
        if (flight.stop.signal.aborted) return json(503, { error: 'busy' }); // drained while the lease was taken: nothing verified yet
        return paidCall(req, svc, agent, agentUuid, input, x402, flight);
      })().finally(() => {
        active--;
        sigsInFlight.delete(sigHash);
        flights.delete(flight);
        tracked.delete(call);
        flight.stop.abort(); // a library 504 leaves our service run going: stop it now
        void release?.().catch(() => undefined); // a failed delete still expires with the lease
      });
      tracked.add(call);
      return call;
    },
  };
}
