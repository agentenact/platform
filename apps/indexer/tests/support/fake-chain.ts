import { Address, Keypair, nativeToScVal, xdr, type Transaction } from '@stellar/stellar-sdk';
import type { HorizonPaymentRecord } from '../../src/chain/horizon.js';
import type { RawEvent, SorobanRpc } from '../../src/chain/registry.js';

export const USDC = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const USDC_ISSUER = USDC.split(':')[1]!;
export const LOOKALIKE_ISSUER = Keypair.random().publicKey();
export const REGISTRY = 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH';
export const PASSPHRASE = 'Test SDF Network ; September 2015';

export const OWNER = Keypair.random().publicKey();
export const WALLET = Keypair.random().publicKey();
export const PAYER = Keypair.random().publicKey();

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const usdcRef = { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER };

/** Horizon operation records, in the shape of /accounts/{id}/payments (no join) (optional fields left absent by default). */
export function classicPayment(o: { id: string; hash: string; from?: string; to?: string; amount?: string; at?: string; token?: string; asset?: Record<string, string> }): HorizonPaymentRecord {
  return {
    id: o.id,
    paging_token: o.token ?? o.id,
    type: 'payment',
    created_at: o.at ?? '2026-10-12T10:00:00Z',
    transaction_hash: o.hash,
    transaction_successful: true,
    from: o.from ?? PAYER,
    to: o.to ?? WALLET,
    amount: o.amount ?? '0.0010000',
    ...(o.asset ?? usdcRef),
  };
}

export function sorobanTransfer(o: {
  id: string;
  hash: string;
  token?: string;
  at?: string;
  changes: Array<Record<string, string>>;
  successful?: boolean;
}): HorizonPaymentRecord {
  return {
    id: o.id,
    paging_token: o.token ?? o.id,
    type: 'invoke_host_function',
    created_at: o.at ?? '2026-10-12T10:00:00Z',
    transaction_hash: o.hash,
    transaction_successful: o.successful ?? true,
    asset_balance_changes: o.changes,
  } as HorizonPaymentRecord;
}

export const usdcChange = (type: string, from: string | undefined, to: string, amount: string): Record<string, string> => ({
  type,
  ...(from ? { from } : {}),
  to,
  amount,
  ...usdcRef,
});

export function horizonPage(records: HorizonPaymentRecord[]): unknown {
  return { _links: {}, _embedded: { records } };
}

/** fetch fake that answers from a queue of responses and records the requested URLs. */
export function queueFetch(responses: Array<Response | Error>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return { fetch: f, urls };
}

type SimTx = { operations: Array<{ func: { value(): { functionName(): Buffer } } }> };

/** Fake Soroban RPC. Simulate answers by invoked method name; a string value is an error message, a function receives the call count. */
export function fakeRpc(o: {
  views?: Record<string, xdr.ScVal | string>;
  events?: RawEvent[];
  getEvents?: SorobanRpc['getEvents'];
  latest?: number;
}): SorobanRpc & { simulated: string[] } {
  const simulated: string[] = [];
  return {
    simulated,
    async simulateTransaction(tx: Transaction) {
      const name = (tx as unknown as SimTx).operations[0]!.func.value().functionName().toString();
      simulated.push(name);
      const v = o.views?.[name];
      if (v === undefined) return { error: `unknown method ${name}` };
      if (typeof v === 'string') return { error: v };
      // Real simulate results carry fee/cost data too; the reader only reads result.retval.
      return { id: '1', latestLedger: o.latest ?? 1000, minResourceFee: '154823', result: { auth: [], retval: v }, transactionData: {}, events: [] };
    },
    getEvents: o.getEvents ?? (async () => ({ events: o.events ?? [], cursor: '0000000012345678-0000000001', latestLedger: o.latest ?? 1000 })),
    // The real node answers getHealth with this shape (testnet 2026-10-12). The SDK's own getLatestLedger cannot be used:
    // it decodes the ledger header, and SDK 15.1.0 throws "unknown ScValType member for value 22" on protocol 29.
    async getHealth() {
      const latest = o.latest ?? 1000;
      return { status: 'healthy', latestLedger: latest, latestLedgerCloseTime: '1791839667', oldestLedger: Math.max(1, latest - 120960), oldestLedgerCloseTime: '1791234872', ledgerRetentionWindow: 120960 };
    },
  };
}

export const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
export const addr = (a: string) => new Address(a).toScVal();
export const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const str = (s: string) => nativeToScVal(s, { type: 'string' });

/** Real event ids are TOIDs: `<ledger << 32>-<event index>`, e.g. `0021723712654954496-0000000000` (ledger 5057946). */
export const eventId = (ledger: number, index = 0) => `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-${String(index).padStart(10, '0')}`;

/** An event as `rpc.Server.getEvents` returns it (captured 2026-10-12); the reader reads only a subset of these keys. */
export function rawEvent(o: { topic: xdr.ScVal[]; value?: xdr.ScVal; id?: string; ledger?: number; index?: number; tx?: string; ok?: boolean }): RawEvent & Record<string, unknown> {
  const ledger = o.ledger ?? 500;
  const tx = o.tx ?? 'a'.repeat(64);
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-10-12T10:00:05Z',
    id: o.id ?? eventId(ledger, o.index ?? 0),
    operationIndex: 0,
    transactionIndex: 1,
    txHash: tx,
    inSuccessfulContractCall: o.ok ?? true,
    topic: o.topic,
    value: o.value ?? xdr.ScVal.scvVoid(),
    contractId: REGISTRY,
  };
}

// ---- real registry event shapes (snake_case topics; values are single-field maps) ----

export const bytes = (b: string) => xdr.ScVal.scvBytes(Buffer.from(b, 'ascii'));
const obj = (o: Record<string, unknown>) => nativeToScVal(o);

/** A registration is three events in one transaction, in this order: mint, metadata_set (agentWallet = the OWNER), registered. */
export function registration(o: { agentId: number; owner?: string; uri?: string; ledger?: number; tx?: string }): RawEvent[] {
  const owner = o.owner ?? OWNER;
  const common = { ledger: o.ledger ?? 500, tx: o.tx };
  return [
    rawEvent({ ...common, index: 0, topic: [sym('mint'), addr(owner)], value: obj({ token_id: o.agentId }) }),
    rawEvent({ ...common, index: 1, topic: [sym('metadata_set'), u32(o.agentId), str('agentWallet')], value: obj({ value: Buffer.from(owner, 'ascii') }) }),
    rawEvent({ ...common, index: 2, topic: [sym('registered'), u32(o.agentId), addr(owner)], value: obj({ agent_uri: o.uri ?? 'data:application/json;base64,e30=' }) }),
  ];
}

export const uriUpdated = (o: { agentId: number; uri: string; by?: string; ledger?: number }) =>
  rawEvent({ ledger: o.ledger, topic: [sym('uri_updated'), u32(o.agentId), addr(o.by ?? OWNER)], value: obj({ new_uri: o.uri }) });

export const walletBound = (o: { agentId: number; wallet: string; ledger?: number; key?: string }) =>
  rawEvent({ ledger: o.ledger, topic: [sym('metadata_set'), u32(o.agentId), str(o.key ?? 'agentWallet')], value: obj({ value: Buffer.from(o.wallet, 'ascii') }) });

export const ownerTransfer = (o: { agentId: number; from: string; to: string; ledger?: number }) =>
  rawEvent({ ledger: o.ledger, topic: [sym('transfer'), addr(o.from), addr(o.to)], value: obj({ token_id: o.agentId }) });
