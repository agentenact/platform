/**
 * Hiring another agent (spec §5.7). The library's hire() pays through x402 with a remote payer signer: the
 * agent key stays in the vault, which signs only a pinned-USDC transfer from this agent within its own caps
 * (keys/vault.ts, counted apart from app.spend), over a safeFetch-backed fetch (no redirects, 90 s, 256 KB; plan D7). The offer check
 * (testnet, exact, the pinned testnet USDC, a valid payTo that is not the hirer, amount <= `maxAmount`) is the
 * library's payment guard: hire() refuses before anything is signed. A spend row is reserved before the paid
 * request leaves (the library's `onPay`) and completed with the tx hash (settled), or as unknown: once a
 * signed authorization has left, a missing receipt or a later failure never means "nothing was paid". It is 'failed' only when no payment was claimed.
 * No secret enters this process (plan D8's residual is gone): the library gets a signer, never a key.
 *
 * Networks: Stellar testnet first, then the EVM testnets the vault signs for, then Solana devnet, each with the agent's
 * own wallet there (the EVM and Solana ones are created by the vault on first use). The next network is tried only when the seller's
 * 402 offers nothing payable on this one (`no_offer`): nothing was signed, so nothing was paid. The caps count every
 * network together, here (app.spend) and in the vault.
 */
import { createEvmAdapter } from 'agentenact/adapters/evm';
import { createSolanaAdapter } from 'agentenact/adapters/solana';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import { hire, isPaymentRefusal, paymentRefusal, type PaymentOffer } from 'agentenact/hire';
import { DELEGATION_HEADER, encodeDelegation } from 'agentenact/orchestrate';
import type { ChainAdapter } from 'agentenact';
import type { AgentKeys } from '../keys/rpc.js';
import { EVM_TESTNETS, SOLANA_DEVNET, isVaultRefusal, type EvmTestnet } from '../keys/contract.js';
import { TESTNET } from '../owner-client/testnet.js';
import type { Spend } from '../policy/spend.js';
import { unitsToUsdc, usdcToUnits } from './usdc.js';

export const HIRE_NETWORK = 'stellar:testnet' as const;
/** Tried in this order: the first one the seller offers is the one paid on. */
export const HIRE_NETWORKS = [HIRE_NETWORK, ...(Object.keys(EVM_TESTNETS) as EvmTestnet[]), SOLANA_DEVNET.network] as const;
export type HireNetwork = (typeof HIRE_NETWORKS)[number];
export const HIRE_OUTPUT_MAX_CHARS = 20_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HireRequest {
  agentId: string;
  runId: string;
  mode: 'chat' | 'mission' | 'service';
  url: string;
  input: unknown;
  maxUsdc: string;
  payTo?: string;
  signal?: AbortSignal;
}

/** What the hirer itself knows about the money: 'none' = nothing signed; 'settled' = a valid, recorded tx hash; 'unknown' = a signed authorization left and no proof of the outcome. */
export type PaymentState = 'none' | 'settled' | 'unknown';
export type RecordState = 'verified' | 'missing' | 'inconsistent';
export type FailedCheck = 'signature' | 'settlement' | 'timing' | 'identity';

/** Every field is derived by the hirer; nothing a seller sent (headers, receipt, record text) is echoed. */
export type HireOutcome =
  | {
      ok: true;
      status: number;
      output: unknown;
      payment: PaymentState;
      /** Only when the ledger row was written 'settled': the lowercased 64-hex hash. */
      transaction: string | null;
      /** Set whenever a payment was claimed (settled or unknown). */
      paidUsdc: string | null;
      /** The network paid on; present only when a payment was claimed. */
      network?: HireNetwork;
      record: RecordState;
      failedChecks: FailedCheck[];
      consistent: boolean;
    }
  /** `payment`/`paidUsdc` are present only when a payment was claimed before the failure. */
  | { ok: false; code: string; payment?: 'unknown'; paidUsdc?: string };

export interface Hirer {
  hire(r: HireRequest): Promise<HireOutcome>;
}

/**
 * The delegation a hosted agent sends: it is always the root of its own job (owner runs are never hired), so the
 * hired agent is at depth 1 and the chain so far is this agent's address. The run id is the root task id. Advisory:
 * it lets an honest seller refuse a loop back to this agent before its 402; the caps above bound the money.
 */
export function delegationFor(runId: string, address: string): string {
  return encodeDelegation({ v: 1, root: runId.replace(/-/g, ''), depth: 1, payees: [address] });
}

export function createHirer(d: {
  keys: Pick<AgentKeys, 'paySigner' | 'publicKey' | 'evmWallet' | 'evmPaySigner' | 'solanaWallet' | 'solanaPaySigner'>;
  spend: Spend;
  fetch: Fetch;
  runCap: (mode: HireRequest['mode']) => string;
  /** One adapter per network; defaults to the public testnet endpoints. */
  adapters?: Partial<Record<HireNetwork, ChainAdapter>>;
  /**
   * TEST ONLY. The library hire(); injectable because a real payment signature needs the Stellar RPC.
   * No production wiring may ever pass it (invariants test: `hireFn` appears nowhere in src/ outside this file).
   */
  hireFn?: typeof hire;
  log?: (e: Record<string, string | number>) => void;
}): Hirer {
  const adapters = new Map<HireNetwork, ChainAdapter>();
  const adapterFor = (n: HireNetwork): ChainAdapter => {
    let a = d.adapters?.[n] ?? adapters.get(n);
    if (!a) {
      a = n === HIRE_NETWORK ? createStellarAdapter({ network: 'testnet' }) : n === SOLANA_DEVNET.network ? createSolanaAdapter({ network: n }) : createEvmAdapter({ network: n });
      adapters.set(n, a);
    }
    return a;
  };
  const doHire = d.hireFn ?? hire;
  const log = d.log ?? (() => undefined);

  async function complete(id: string, decision: 'settled' | 'unknown' | 'failed', txHash?: string): Promise<'settled' | 'unknown' | 'failed' | null> {
    try {
      return await d.spend.complete(id, { decision, ...(txHash ? { txHash } : {}) });
    } catch {
      // A DB error: the row stays 'reserved' and counts against the caps (fails safe; boot recovery makes it 'unknown').
      // The seller-supplied hash is never logged.
      log({ event: 'spend_complete_failed', spend: id });
      return null;
    }
  }

  return {
    async hire(r) {
      if (r.mode === 'service') return { ok: false, code: 'not_in_service_runs' };
      let runCap: string;
      let maxUnits: bigint;
      let address: string | null;
      try {
        // The runner and the Toolbox check no agent status (P3a carry-forward); Spend.reserve checks again at payment.
        if (!(await d.spend.agentActive(r.agentId))) return { ok: false, code: 'agent_not_active' };
        address = await d.keys.publicKey(r.agentId);
        if (!address) return { ok: false, code: 'no_key' };
        runCap = d.runCap(r.mode);
        const head = usdcToUnits(await d.spend.headroom(r.agentId, r.runId, runCap));
        const asked = usdcToUnits(r.maxUsdc);
        maxUnits = asked < head ? asked : head;
      } catch {
        // A DB or config error before anything was signed: a fixed code, never the raw message. Nothing is paid.
        log({ event: 'hire_failed', agent: r.agentId, paid: 0 });
        return { ok: false, code: 'hire_failed' };
      }
      if (maxUnits <= 0n) return { ok: false, code: 'cap_reached' };

      let spendId: string | undefined;
      // Set by onPay once the spend is reserved: from then on the signed payment is on its way (the library calls
      // onPay on the signed request and sends it immediately after).
      let claimedOffer: PaymentOffer | undefined;
      // True once the paid request has been answered: a later throw is in verification (or reading the body), not in sending.
      let answered = false;
      // The seller's 402 lists every network it takes, so one probe serves every network tried: later probes reuse it.
      let probe: { body: ArrayBuffer; status: number; headers: Headers } | undefined;
      const meteredFetch: Fetch = async (input, init) => {
        const paidRequest = claimedOffer !== undefined; // the probe goes out before the claim, the signed request after
        if (!paidRequest && probe) return new Response(probe.body.slice(0), { status: probe.status, headers: probe.headers });
        const res = await d.fetch(input, init);
        if (!paidRequest && res.status === 402) probe = { body: await res.clone().arrayBuffer(), status: 402, headers: new Headers(res.headers) };
        if (paidRequest) answered = true;
        return res;
      };
      const paidFields = () => (claimedOffer ? claimedOffer.decimal : null);
      const onPay = async (offer: PaymentOffer, network: HireNetwork) => {
        const res = await d.spend.reserve({ agentId: r.agentId, runId: r.runId, url: r.url, payee: offer.payTo, amountUsdc: offer.decimal, runCapUsdc: runCap, network });
        if (!res.ok) throw paymentRefusal(res.code);
        spendId = res.id;
        claimedOffer = offer;
      };

      let result: Awaited<ReturnType<typeof hire>> | undefined;
      let paidOn: HireNetwork | null = null;
      for (const network of HIRE_NETWORKS) {
        const solana = network === SOLANA_DEVNET.network;
        const evm = network !== HIRE_NETWORK && !solana;
        // EVM and Solana USDC have 6 decimals, Stellar's 7.
        const six = evm || solana;
        try {
          // The agent's wallet on this network: the vault makes the EVM and Solana ones on first use (only for an active agent).
          const payer = solana ? await d.keys.solanaWallet(r.agentId, network) : evm ? await d.keys.evmWallet(r.agentId, network) : address;
          const signer = solana ? d.keys.solanaPaySigner(r.agentId, network, payer) : evm ? d.keys.evmPaySigner(r.agentId, network, payer) : d.keys.paySigner(r.agentId, payer);
          result = await doHire(
            r.url,
            { method: 'POST', headers: { 'content-type': 'application/json', [DELEGATION_HEADER]: delegationFor(r.runId, payer) }, body: JSON.stringify(r.input ?? null), ...(r.signal ? { signal: r.signal } : {}) },
            {
              adapter: adapterFor(network),
              payer: { signer, network },
              // 6-decimal USDC: the cap is floored to them, never rounded up past the headroom.
              maxAmount: six ? unitsToUsdc((maxUnits / 10n) * 10n).replace(/0$/, '') : unitsToUsdc(maxUnits),
              asset: solana ? SOLANA_DEVNET.usdc : evm ? EVM_TESTNETS[network as EvmTestnet].usdc : TESTNET.usdc,
              ...(r.payTo ? { payTo: r.payTo } : {}),
              onPay: async (offer) => {
                await onPay(offer, network);
                paidOn = network;
              },
              fetch: meteredFetch as unknown as typeof fetch,
            },
          );
          break;
        } catch (e) {
          // Anything after a claimed payment is "paid, outcome unknown", whatever the error says (even a late guard refusal).
          if (claimedOffer) {
            if (spendId) await complete(spendId, 'unknown');
            log({ event: 'hire_failed', agent: r.agentId, paid: 1 });
            const paid = paidFields();
            return { ok: false, code: answered ? 'verify_failed' : 'hire_failed_after_payment', payment: 'unknown', ...(paid ? { paidUsdc: paid } : {}) };
          }
          // Nothing payable on this network and nothing signed: try the next one.
          if (isPaymentRefusal(e) && e.reason === 'no_offer' && network !== HIRE_NETWORKS[HIRE_NETWORKS.length - 1]) continue;
          if (isPaymentRefusal(e)) return { ok: false, code: `refused_${String(e.reason)}` };
          // The vault refused to sign (its own caps or checks): nothing was signed, so nothing was paid.
          if (isVaultRefusal(e)) return { ok: false, code: `vault_${e.reason}` };
          log({ event: 'hire_failed', agent: r.agentId, paid: 0 });
          return { ok: false, code: 'hire_failed' };
        }
      }
      if (!result) return { ok: false, code: 'hire_failed' };

      // A payment was claimed but no receipt came back: unknown, never failed (the authorization left, so it may settle).
      const claimed = claimedOffer !== undefined;
      // Seller-controlled: the library decodes the receipt without checking types.
      const rawTx: unknown = result.settlement?.transaction;
      const sellerTx = typeof rawTx === 'string' ? rawTx : undefined;
      // The library's own check of the receipt against chain data: a failed settlement check means the seller's hash is not proof.
      const settlementFailed = result.verification?.checks.settlement === 'fail';
      const trusted = claimed && sellerTx !== undefined && !settlementFailed;
      const written = spendId ? await complete(spendId, claimed ? (trusted ? 'settled' : 'unknown') : 'failed', trusted ? sellerTx : undefined) : null;
      // The state is what the ledger says: a missing, malformed or duplicate hash was demoted to 'unknown' inside complete().
      const payment: PaymentState = !claimed ? 'none' : written === 'settled' ? 'settled' : 'unknown';
      const text = new TextDecoder().decode(result.output);
      let output: unknown = text.slice(0, HIRE_OUTPUT_MAX_CHARS);
      if (text.length <= HIRE_OUTPUT_MAX_CHARS) {
        try {
          output = JSON.parse(text);
        } catch {
          // not JSON: keep the text
        }
      }
      const failedChecks = result.verification
        ? (['signature', 'settlement', 'timing', 'identity'] as const).filter((c) => result.verification!.checks[c] === 'fail')
        : [];
      return {
        ok: true,
        status: result.response.status,
        output,
        payment,
        // Hex hashes lowercased (as stored); a Solana signature is base58 and keeps its case.
        transaction: payment === 'settled' && sellerTx ? (paidOn === SOLANA_DEVNET.network ? sellerTx : sellerTx.toLowerCase()) : null,
        paidUsdc: paidFields(),
        ...(claimed && paidOn ? { network: paidOn as HireNetwork } : {}),
        record: !result.record ? 'missing' : result.consistent ? 'verified' : 'inconsistent',
        failedChecks,
        consistent: result.consistent,
      };
    },
  };
}
