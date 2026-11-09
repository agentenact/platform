/**
 * Timing spike (gate 2): how long may a paid x402 handler run before settlement on Stellar testnet?
 * TESTNET ONLY. Secrets are read from process env (bun --env-file); never printed.
 *
 *   bun run measure 0:5 10:3 20:3     # delaySeconds:repeats ...
 * Appends one JSON line per run to results.jsonl.
 */
import { appendFileSync } from 'node:fs';
import { Keypair, TransactionBuilder, Networks, xdr } from '@stellar/stellar-sdk';
import { createStellarAdapter, stellarSecretToBytes } from '../../../agentenact/src/adapters/stellar.ts';
import { createEnactServer, createX402Server, type X402Server } from '../../../agentenact/src/serve.ts';
import { hire } from '../../../agentenact/src/hire.ts';

const env = process.env;
if (!env.SPONSOR_SECRET || !env.PAYER_SECRET || !env.OZ_API_KEY) throw new Error('testnet env not loaded');
const NETWORK = 'stellar:testnet' as const;
const RPC = 'https://soroban-testnet.stellar.org';
const HORIZON = 'https://horizon-testnet.stellar.org';
const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (n: number) => Math.round(n);

async function rpcLatestLedger(): Promise<number> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
  });
  return ((await res.json()) as any).result.sequence;
}
async function avgLedgerSeconds(): Promise<number> {
  const j: any = await (await fetch(`${HORIZON}/ledgers?order=desc&limit=20`)).json();
  const t = j._embedded.records.map((r: any) => Date.parse(r.closed_at));
  return (t[0] - t[t.length - 1]) / 1000 / (t.length - 1);
}
function expirationLedger(sigHeader: string): number {
  const p = JSON.parse(Buffer.from(sigHeader, 'base64').toString());
  const tx = TransactionBuilder.fromXDR(p.payload.transaction, Networks.TESTNET) as any;
  const auth = tx.operations[0].auth as xdr.SorobanAuthorizationEntry[];
  return Math.max(...auth.map((a) => a.credentials().address().signatureExpirationLedger()));
}

// ---- server ----
const agent = Keypair.fromSecret(env.SPONSOR_SECRET);
const adapter = createStellarAdapter({ network: 'testnet' });
type Run = Record<string, any>;
let cur: Run = {};
let handlerDelayMs = 0;

const timedAdapter = {
  ...adapter,
  async sign(d: Uint8Array, s: Uint8Array) {
    const t = now();
    const out = await adapter.sign(d, s);
    cur.recordSignMs = now() - t;
    return out;
  },
};

const real = await createX402Server({
  network: NETWORK,
  agent: { address: agent.publicKey(), secret: stellarSecretToBytes(agent.secret()) },
  price: '$0.001',
  facilitator: { url: 'https://channels.openzeppelin.com/x402/testnet', apiKey: env.OZ_API_KEY },
  resource: 'http://localhost/spike',
});
const timedX402: X402Server = {
  accepts: () => real.accepts(),
  paymentRequired: () => real.paymentRequired(),
  async verify(h) {
    const t = now();
    const v = await real.verify(h);
    cur.verifyMs = now() - t;
    cur.verifyOk = v.ok;
    if (!v.ok) cur.verifyReason = v.reason;
    return v;
  },
  async settle(p, r) {
    const t = now();
    cur.settleStartAtMs = t; // converted to "auth age" later
    try {
      const s = await real.settle(p, r);
      cur.settleMs = now() - t;
      cur.settleOk = s.ok;
      if (!s.ok) cur.settleReason = s.reason;
      return s;
    } catch (e) {
      cur.settleMs = now() - t;
      cur.settleOk = false;
      cur.settleReason = 'threw:' + (e as Error).message.slice(0, 120);
      throw e;
    }
  },
};
const handler = await createEnactServer({
  network: NETWORK,
  agent: { address: agent.publicKey(), secret: stellarSecretToBytes(agent.secret()) },
  adapter: timedAdapter,
  price: '$0.001',
  facilitator: { url: 'x', apiKey: 'x' },
  resource: 'http://localhost/spike',
  x402: timedX402,
  handlerTimeoutMs: 900_000, // raised far above the 45 s default so the library timer never interferes
  handler: async (input) => {
    await sleep(handlerDelayMs);
    return { body: new TextEncoder().encode(JSON.stringify({ n: input.byteLength })), mediaType: 'application/json' };
  },
});
const srv = Bun.serve({
  port: 0,
  idleTimeout: 255,
  fetch: (req) => {
    if (req.headers.get('PAYMENT-SIGNATURE')) cur.serverRecvAt = now();
    return handler(req);
  },
});

// ---- buyer fetch wrapper (base fetch under x402's paying fetch) ----
const baseFetch: typeof fetch = async (input, init) => {
  const hdrs = new Headers((init as any)?.headers ?? (input as Request).headers);
  const sig = hdrs.get('PAYMENT-SIGNATURE');
  if (!sig) {
    cur.req1At = now();
    const res = await fetch(input as any, { ...init, timeout: false } as any);
    cur.got402At = now();
    return res;
  }
  cur.signedAt = now();
  cur.ledgerAtSignP = rpcLatestLedger(); // off the critical path
  cur.expLedger = expirationLedger(sig);
  return fetch(input as any, { ...init, timeout: false } as any); // Bun's default fetch timeout (~300 s) would abort long handlers
};

const lines: string[] = [];
async function one(delayS: number, idx: number) {
  cur = { delayS, idx, startedAt: new Date().toISOString() };
  handlerDelayMs = delayS * 1000;
  const t0 = now();
  const r = await hire(
    `http://localhost:${srv.port}/spike`,
    { method: 'POST', body: 'hello spike' },
    { adapter, fetch: baseFetch, payer: { secret: env.PAYER_SECRET!, network: NETWORK } },
  );
  cur.e2eMs = now() - t0;
  const ledgerAtSign = await cur.ledgerAtSignP;
  const avg = await avgLedgerSeconds();
  const out: Run = {
    delayS, idx, startedAt: cur.startedAt,
    status: r.response.status,
    consistent: r.consistent,
    tx: r.settlement?.transaction ?? null,
    problems: r.problems,
    errorBody: r.response.status === 200 ? undefined : new TextDecoder().decode(r.output).slice(0, 200),
    buyerSignMs: r1(cur.signedAt - cur.got402At),
    firstRoundtripMs: r1(cur.got402At - cur.req1At),
    sigToServerMs: cur.serverRecvAt ? r1(cur.serverRecvAt - cur.signedAt) : null,
    verifyMs: cur.verifyMs && r1(cur.verifyMs),
    authAgeAtSettleStartMs: cur.settleStartAtMs ? r1(cur.settleStartAtMs - cur.signedAt) : null,
    settleMs: cur.settleMs && r1(cur.settleMs),
    settleOk: cur.settleOk, settleReason: cur.settleReason, verifyOk: cur.verifyOk, verifyReason: cur.verifyReason,
    recordSignMs: cur.recordSignMs && Math.round(cur.recordSignMs * 100) / 100,
    e2eMs: r1(cur.e2eMs),
    expLedger: cur.expLedger, ledgerAtSign, ledgersAhead: cur.expLedger - ledgerAtSign, avgLedgerS: Math.round(avg * 100) / 100,
    expSecondsAhead: Math.round((cur.expLedger - ledgerAtSign) * avg),
  };
  appendFileSync('results.jsonl', JSON.stringify(out) + '\n');
  console.log(JSON.stringify(out));
}

for (const spec of process.argv.slice(2)) {
  const [d, n] = spec.split(':').map(Number);
  for (let i = 0; i < n; i++) await one(d, i);
}
srv.stop(true);
process.exit(0);
