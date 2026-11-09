/**
 * The vault: the only process that opens agent keys. It runs apart from the api (src/vault-main.ts), holds
 * KEYS_MASTER_SECRET through `keys`, and signs only payloads it has decoded and checked itself. It never signs a
 * bare digest: a Stellar tx hash is also 32 bytes, so a "sign this hash" call could be made to sign anything.
 *
 *   birth   the sponsored account tx (exact 4-op shape)               agent provisioning
 *   bind    set_agent_wallet(owner, id, agent) for the agent's owner  agent provisioning
 *   record  an Enactment Record for this agent, one per settlement    agent active
 *   payment a pinned-USDC transfer from this agent, within the caps   agent active
 *   sponsor a platform tx the sponsor sources (chain/sponsor.ts shapes)  within the day fee cap; a testnet credit
 *           (agents/credit-tx.ts) also only to a live hosted agent, once per VAULT_CREDIT_EVERY_H hours, VAULT_CREDITS_PER_DAY in all
 *   evm_payment  an EIP-3009 USDC authorization from the agent's EVM key   agent active, same caps as payment
 *   evm_record   an Enactment Record (EIP-191) for a settlement on an EVM testnet
 *   solana_payment  an x402 exact TransferChecked of devnet USDC from the agent's Solana key   agent active, same caps
 *   seal    the agent's own check-seal tx (seals/tx.ts: a no-op carrying a hash), at most SEALS_PER_AGENT_DAY a day
 *   close   a deleted agent's own close tx (agents/close-tx.ts): a sweep to its owner, a merge to its owner or the sponsor
 *   reserve the agent's part of a reserve tx (agents/reserve-tx.ts): buying its own reserves (a due agent, repaying exactly
 *           the fees the sponsor fronted) or a fee float (a self-paying one), at most HANDOVERS_PER_AGENT_DAY a day, or
 *           handing them back to the sponsor once deleted
 *
 * The EVM key is created on first use (evmWallet), only for an active agent, only on EVM_TESTNETS; the Solana key the
 * same way (solanaWallet), only on SOLANA_DEVNET. One day cap
 * covers every chain: EVM amounts (6 decimals) are counted in the Stellar ledger's 7-decimal units.
 *
 * Every signature is a row in keyvault.signatures. Payment caps are counted there under a per-agent advisory
 * lock, check → insert → sign, so an api that is taken over can ask for signatures but never past the caps.
 * The day caps, the credit spacing and the seal cap can be tightened by the operator (app.ops_settings, ops/settings.ts),
 * never loosened past the constants below. Testnet only.
 */
import { Address, Keypair, TransactionBuilder, xdr, type Transaction } from '@stellar/stellar-sdk';
import { bytesToHex, parseUnsignedRecord, recordDigest, type EnactmentRecord, type UnsignedEnactmentRecord } from 'agentenact';
import { checkBindPreimage, checkBirthTransaction, type StellarSigner } from 'agentenact/create';
import { decodeEvmTransfer, decodeSolanaTransfer, decodeStellarTransfer } from 'agentenact/signer';
import { base58Encode, ed25519Sign } from 'agentenact/adapters/solana';
import type { WireTypedData } from 'agentenact/wallet';
import type { Db } from '../db/index.js';
import { TESTNET } from '../owner-client/testnet.js';
import type { SponsorPolicy } from '../chain/sponsor.js';
import type { Keys } from './index.js';
import { sealShape } from '../seals/tx.js';
import { closeShape } from '../agents/close-tx.js';
import { reserveShape } from '../agents/reserve-tx.js';
import { EVM_TESTNETS, SOLANA_DEVNET, isSolanaAddress, vaultRefusal, type EvmTestnet, type Vault } from './contract.js';
import { effectiveVaultLimits, readSettings, type VaultLimits } from '../ops/settings.js';

export { EVM_TESTNETS, type EvmTestnet, type Vault } from './contract.js';

const NETWORK = 'stellar:testnet' as const;
/** The vault's own payment caps, in USDC base units (7 decimals). Equal to the api's hire caps (policy/spend.ts); a backstop, not a second policy. */
export const VAULT_PER_CALL_UNITS = 500_000n; // 0.05 USDC
export const VAULT_PER_AGENT_DAY_UNITS = 10_000_000n; // 1.00 USDC
/** A record's issuedAt may be at most this far from the vault's clock. */
const RECORD_SKEW_MS = 5 * 60_000;
// Two-key advisory lock: its own namespace ('AEV1'), distinct from the spend (0x41455331), memory and replica locks.
const VAULT_LOCK_NAMESPACE = 0x41455631;
/** The sponsor's fee budget per UTC day, in stroops, counted on the fee each signed tx bids (its maximum): 1,000 XLM. */
export const VAULT_SPONSOR_DAY_FEE_STROOPS = 10_000_000_000n;
/** Testnet credits (agents/credit-tx.ts) the sponsor may send per UTC day, all agents together: at most ~1,000 XLM spent. */
export const VAULT_CREDITS_PER_DAY = 50;
/**
 * One credit per agent per this many hours. The vault counts a credit when it signs and cannot see the chain, so a credit
 * that never lands holds the agent back this long: short, because the day total above is what bounds the spend.
 */
export const VAULT_CREDIT_EVERY_H = 2;
// Its own lock key: one sponsor, one counter.
const SPONSOR_LOCK_KEY = 0x53504f4e; // 'SPON'
/** Check seals an agent may sign per UTC day: a check every 5 minutes is 288, so this leaves room for retries. */
export const SEALS_PER_AGENT_DAY = 1000;
/** A seal tx may stay valid at most this long past the vault's clock. */
const SEAL_MAX_VALIDITY_S = 600;
/** A close tx may stay valid at most this long past the vault's clock. */
const CLOSE_MAX_VALIDITY_S = 600;
/** A reserve tx may stay valid at most this long past the vault's clock. */
const RESERVE_MAX_VALIDITY_S = 600;
/** Handovers an agent may sign per UTC day: each spends up to RESERVE_MAX_SEND_UNITS, and one that lands ends them. */
export const HANDOVERS_PER_AGENT_DAY = 3;
/** EVM USDC has 6 decimals, the vault's ledger 7. */
const EVM_UNIT_SCALE = 10n;
/** An EVM authorization may stay valid at most this long (x402 asks for 300 s; a margin for clock skew). */
const EVM_MAX_VALIDITY_S = 600;
const evmNet = (network: unknown) => {
  if (typeof network !== 'string' || !Object.hasOwn(EVM_TESTNETS, network)) throw vaultRefusal('wrong_network');
  return { network: network as EvmTestnet, ...EVM_TESTNETS[network as EvmTestnet] };
};

const solanaNet = (network: unknown) => {
  if (network !== SOLANA_DEVNET.network) throw vaultRefusal('wrong_network');
  return SOLANA_DEVNET;
};

/** The code ceilings: the operator's limits (app.ops_settings) can only tighten these (ops/settings.ts). */
export const VAULT_CEILINGS: VaultLimits = {
  sponsorDayFeeStroops: VAULT_SPONSOR_DAY_FEE_STROOPS,
  creditsPerDay: VAULT_CREDITS_PER_DAY,
  creditEveryH: VAULT_CREDIT_EVERY_H,
  agentDayUnits: VAULT_PER_AGENT_DAY_UNITS,
  sealsPerAgentDay: SEALS_PER_AGENT_DAY,
};

interface AgentRow {
  status: string;
  agent_id: string | null;
  owner_address: string | null;
  public_key: string | null;
  /** The owner the vault itself signed into the bind entry (keyvault, out of the api's reach): where a close may go. */
  pinned_owner: string | null;
}

export function createVault(d: { sql: Db; keys: Keys; sponsor?: StellarSigner & { policy: SponsorPolicy }; now?: () => Date }): Vault {
  const { sql, keys, sponsor } = d;
  const now = d.now ?? (() => new Date());

  /**
   * The limits in force now, read outside the signing transaction (a failed read inside it would abort it). A table that
   * cannot be read means the code ceilings: what the vault enforced before the panel could set anything.
   */
  async function limits(): Promise<VaultLimits> {
    try {
      return effectiveVaultLimits(await readSettings(sql), VAULT_CEILINGS);
    } catch {
      return VAULT_CEILINGS;
    }
  }

  async function agent(agentId: string): Promise<AgentRow & { public_key: string }> {
    const rows = (await sql`select a.status, a.agent_id, u.owner_address, k.public_key, k.owner_address as pinned_owner
                            from app.agents a join app.users u on u.id = a.user_id
                            left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'stellar' and k.destroyed_at is null
                            where a.id = ${agentId}`) as AgentRow[];
    const row = rows[0];
    if (!row?.public_key) throw vaultRefusal('no_key');
    return row as AgentRow & { public_key: string };
  }

  const sign = (agentId: string, digest: Buffer, publicKey: string) =>
    keys.withSecret(agentId, async (kp: Keypair) => {
      if (kp.publicKey() !== publicKey) throw vaultRefusal('no_key'); // rotated between the check and the open
      return kp.sign(digest);
    });

  /** What the agent signed for today, on every chain, in 7-decimal units. Call inside the agent's advisory lock. */
  async function daySpent(tx: Db, agentId: string): Promise<string> {
    const [s] = (await tx`select coalesce(sum(amount_units), 0)::text as day from keyvault.signatures
                          where agent_id = ${agentId} and kind in ('payment', 'evm_payment', 'solana_payment') and at >= date_trunc('day', now(), 'UTC')`) as { day: string }[];
    return s!.day;
  }

  async function status(agentId: string): Promise<string | null> {
    const rows = (await sql`select status from app.agents where id = ${agentId}`) as { status: string }[];
    return rows[0]?.status ?? null;
  }

  async function note(agentId: string, kind: 'birth' | 'bind', digest: Buffer) {
    await sql`insert into keyvault.signatures (agent_id, kind, digest) values (${agentId}, ${kind}, ${digest.toString('hex')})`;
  }

  return {
    generate: (agentId) => keys.generate(agentId),
    destroy: (agentId) => keys.destroy(agentId),
    publicKey: (agentId) => keys.publicKey(agentId),
    async webhookSecret(agentId) {
      return keys.webhookSecret(agentId);
    },

    async signBirthTx(agentId, envelopeXdr, networkPassphrase) {
      if (networkPassphrase !== TESTNET.passphrase) throw vaultRefusal('wrong_network');
      const a = await agent(agentId);
      if (a.status !== 'provisioning') throw vaultRefusal('not_provisioning');
      let digest: Buffer;
      try {
        digest = checkBirthTransaction(envelopeXdr, { network: NETWORK, agent: a.public_key });
      } catch {
        throw vaultRefusal('bad_payload');
      }
      await note(agentId, 'birth', digest);
      return (await sign(agentId, digest, a.public_key)).toString('base64');
    },

    async signBindEntry(agentId, preimage) {
      const a = await agent(agentId);
      if (a.status !== 'provisioning') throw vaultRefusal('not_provisioning');
      let digest: Buffer;
      let owner: string;
      try {
        digest = checkBindPreimage(preimage, { network: NETWORK, agent: a.public_key, registry: TESTNET.registry });
        // checkBindPreimage pins the call; the owner argument must be this agent's owner, not any address.
        const args = xdr.HashIdPreimage.fromXDR(Buffer.from(preimage, 'base64')).sorobanAuthorization().invocation().function().contractFn().args();
        owner = Address.fromScVal(args[0]!).toString();
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (!a.owner_address || owner !== a.owner_address) throw vaultRefusal('wrong_owner');
      // Pin the owner in the vault's own schema: a close goes only here, whatever app.users says later. A pin never moves.
      if (a.pinned_owner !== null && a.pinned_owner !== owner) throw vaultRefusal('wrong_owner');
      const pinned = await sql`update keyvault.keys set owner_address = ${owner}
                               where agent_id = ${agentId} and chain_family = 'stellar' and public_key = ${a.public_key} and destroyed_at is null
                                 and (owner_address is null or owner_address = ${owner}) returning agent_id`;
      if (pinned.length === 0) throw vaultRefusal('wrong_owner');
      await note(agentId, 'bind', digest);
      return (await sign(agentId, digest, a.public_key)).toString('base64');
    },

    async signRecord(agentId, input) {
      let u: UnsignedEnactmentRecord;
      try {
        u = parseUnsignedRecord(input);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      const a = await agent(agentId);
      // A paused agent still owes the record of a call its buyer already paid for; a revoked one signs nothing.
      if (a.status !== 'active' && a.status !== 'paused') throw vaultRefusal('not_active');
      if (u.agent.chain !== 'stellar' || u.settlement.chain !== 'stellar') throw vaultRefusal('wrong_network');
      if (u.agent.address !== a.public_key) throw vaultRefusal('wrong_wallet');
      if (u.agent.agentId !== undefined && u.agent.agentId !== a.agent_id) throw vaultRefusal('bad_payload');
      if (u.settlement.asset !== TESTNET.usdc || u.settlement.payer === a.public_key) throw vaultRefusal('bad_payload');
      const ref = u.settlement.ref.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(ref)) throw vaultRefusal('bad_payload');
      if (Math.abs(Date.parse(u.issuedAt) - now().getTime()) > RECORD_SKEW_MS) throw vaultRefusal('bad_payload');
      const digest = Buffer.from(await recordDigest(u));
      try {
        await sql`insert into keyvault.signatures (agent_id, kind, digest, ref) values (${agentId}, 'record', ${digest.toString('hex')}, ${ref})`;
      } catch (e) {
        // One record per settlement: a second one for the same payment would be a second claim about what it bought.
        if ((e as { errno?: string }).errno === '23505') throw vaultRefusal('record_exists');
        throw e;
      }
      const sig = await sign(agentId, digest, a.public_key);
      return { ...u, sig: { alg: 'ed25519', value: bytesToHex(sig) } };
    },

    async signPayment(agentId, preimage) {
      let intent: Awaited<ReturnType<typeof decodeStellarTransfer>>;
      try {
        intent = await decodeStellarTransfer(preimage, NETWORK);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (intent.asset !== TESTNET.usdc) throw vaultRefusal('bad_payload');
      if (intent.amount <= 0n || intent.amount > VAULT_PER_CALL_UNITS) throw vaultRefusal('over_call_cap');
      if (!/^[GC][A-Z2-7]{55}$/.test(intent.payTo)) throw vaultRefusal('bad_payload');
      const digest = Buffer.from(new Bun.CryptoHasher('sha256').update(Buffer.from(preimage, 'base64')).digest());
      const lim = await limits();
      const publicKey = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await tx`select a.status, k.public_key from app.agents a
                               left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'stellar' and k.destroyed_at is null
                               where a.id = ${agentId}`) as { status: string; public_key: string | null }[];
        const a = rows[0];
        if (!a?.public_key) throw vaultRefusal('no_key');
        if (a.status !== 'active') throw vaultRefusal('not_active');
        if (intent.from !== a.public_key) throw vaultRefusal('wrong_wallet');
        if (intent.payTo === a.public_key) throw vaultRefusal('bad_payload');
        if (BigInt(await daySpent(tx, agentId)) + intent.amount > lim.agentDayUnits) throw vaultRefusal('over_day_cap');
        // Counted before it is signed: a signature that never gets used still counts (fails safe).
        await tx`insert into keyvault.signatures (agent_id, kind, digest, payee, amount_units)
                 values (${agentId}, 'payment', ${digest.toString('hex')}, ${intent.payTo}, ${intent.amount.toString()})`;
        return a.public_key;
      });
      return (await sign(agentId, digest, publicKey)).toString('base64');
    },

    evmAddress: (agentId) => keys.evmAddress(agentId),

    async evmWallet(agentId, network) {
      evmNet(network);
      const st = await status(agentId);
      if (st === null) throw vaultRefusal('no_key');
      // An existing wallet is shown in any state (its funds stay visible); a new one is made only for an active agent.
      const existing = await keys.evmAddress(agentId);
      if (existing) return existing;
      if (st !== 'active') throw vaultRefusal('not_active');
      return (await keys.ensureEvm(agentId)).address;
    },

    async signEvmPayment(agentId, network, typedData) {
      const net = evmNet(network);
      let t: Awaited<ReturnType<typeof decodeEvmTransfer>>;
      try {
        t = await decodeEvmTransfer(typedData as WireTypedData, net.network, { now: now(), maxValiditySeconds: EVM_MAX_VALIDITY_S });
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (t.intent.asset !== net.usdc) throw vaultRefusal('bad_payload');
      const units = t.intent.amount * EVM_UNIT_SCALE;
      if (t.intent.amount <= 0n || units > VAULT_PER_CALL_UNITS) throw vaultRefusal('over_call_cap');
      // What is signed and what is counted is the same rebuilt typed data: its EIP-712 hash is the ledger digest.
      const { hashTypedData } = await import('viem');
      const digest = hashTypedData(t.typedData).slice(2);
      const lim = await limits();
      const address = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await tx`select a.status, k.public_key from app.agents a
                               left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'evm' and k.destroyed_at is null
                               where a.id = ${agentId}`) as { status: string; public_key: string | null }[];
        const a = rows[0];
        if (!a?.public_key) throw vaultRefusal('no_key');
        if (a.status !== 'active') throw vaultRefusal('not_active');
        if (t.intent.from !== a.public_key) throw vaultRefusal('wrong_wallet');
        if (t.intent.payTo === a.public_key) throw vaultRefusal('bad_payload');
        if (BigInt(await daySpent(tx, agentId)) + units > lim.agentDayUnits) throw vaultRefusal('over_day_cap');
        await tx`insert into keyvault.signatures (agent_id, kind, digest, payee, amount_units, network)
                 values (${agentId}, 'evm_payment', ${digest}, ${t.intent.payTo}, ${units.toString()}, ${net.network})`;
        return a.public_key;
      });
      return keys.withEvmAccount(agentId, async (account) => {
        if (account.address.toLowerCase() !== address) throw vaultRefusal('no_key');
        return account.signTypedData(t.typedData);
      });
    },

    solanaAddress: (agentId) => keys.solanaAddress(agentId),

    async solanaWallet(agentId, network) {
      solanaNet(network);
      const st = await status(agentId);
      if (st === null) throw vaultRefusal('no_key');
      const existing = await keys.solanaAddress(agentId);
      if (existing) return existing;
      if (st !== 'active') throw vaultRefusal('not_active');
      return (await keys.ensureSolana(agentId)).address;
    },

    async signSolanaPayment(agentId, network, message, payTo) {
      const net = solanaNet(network);
      if (!isSolanaAddress(payTo)) throw vaultRefusal('bad_payload');
      const address = await keys.solanaAddress(agentId);
      if (!address) throw vaultRefusal('no_key');
      let t: Awaited<ReturnType<typeof decodeSolanaTransfer>>;
      try {
        // The decoder pins the mint, the payer as the only authority, payTo's token account and a fee payer that is not the agent.
        t = await decodeSolanaTransfer(message, net.network, { payer: address, payTo });
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (t.intent.asset !== net.usdc) throw vaultRefusal('bad_payload');
      const units = t.intent.amount * EVM_UNIT_SCALE; // devnet USDC has 6 decimals, like EVM
      if (t.intent.amount <= 0n || units > VAULT_PER_CALL_UNITS) throw vaultRefusal('over_call_cap');
      const digest = new Bun.CryptoHasher('sha256').update(t.message).digest('hex');
      const lim = await limits();
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await tx`select a.status, k.public_key from app.agents a
                               left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'solana' and k.destroyed_at is null
                               where a.id = ${agentId}`) as { status: string; public_key: string | null }[];
        const a = rows[0];
        if (!a?.public_key || a.public_key !== address) throw vaultRefusal('no_key');
        if (a.status !== 'active') throw vaultRefusal('not_active');
        if (BigInt(await daySpent(tx, agentId)) + units > lim.agentDayUnits) throw vaultRefusal('over_day_cap');
        await tx`insert into keyvault.signatures (agent_id, kind, digest, payee, amount_units, network)
                 values (${agentId}, 'solana_payment', ${digest}, ${payTo}, ${units.toString()}, ${net.network})`;
      });
      return keys.withSolanaSeed(agentId, async (seed, held) => {
        if (held !== address) throw vaultRefusal('no_key');
        return base58Encode(await ed25519Sign(t.message, seed));
      });
    },

    async signEvmRecord(agentId, network, input) {
      const net = evmNet(network);
      let u: UnsignedEnactmentRecord;
      try {
        u = parseUnsignedRecord(input);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      const st = await status(agentId);
      if (st === null) throw vaultRefusal('no_key');
      if (st !== 'active' && st !== 'paused') throw vaultRefusal('not_active');
      const address = await keys.evmAddress(agentId);
      if (!address) throw vaultRefusal('no_key');
      if (u.agent.chain !== net.chain || u.settlement.chain !== net.chain) throw vaultRefusal('wrong_network');
      if (u.agent.address !== address) throw vaultRefusal('wrong_wallet');
      const rows = (await sql`select agent_id from app.agents where id = ${agentId}`) as { agent_id: string | null }[];
      if (u.agent.agentId !== undefined && u.agent.agentId !== rows[0]?.agent_id) throw vaultRefusal('bad_payload');
      if (u.settlement.asset !== net.usdc || !/^0x[0-9a-f]{40}$/.test(u.settlement.payer) || u.settlement.payer === address) {
        throw vaultRefusal('bad_payload');
      }
      const m = /^0x([0-9a-f]{64})$/.exec(u.settlement.ref);
      if (!m) throw vaultRefusal('bad_payload');
      if (Math.abs(Date.parse(u.issuedAt) - now().getTime()) > RECORD_SKEW_MS) throw vaultRefusal('bad_payload');
      const digest = await recordDigest(u);
      try {
        await sql`insert into keyvault.signatures (agent_id, kind, digest, ref, network)
                  values (${agentId}, 'evm_record', ${bytesToHex(digest)}, ${m[1]!}, ${net.network})`;
      } catch (e) {
        if ((e as { errno?: string }).errno === '23505') throw vaultRefusal('record_exists');
        throw e;
      }
      const value = await keys.withEvmAccount(agentId, async (account) => {
        if (account.address.toLowerCase() !== address) throw vaultRefusal('no_key');
        return account.signMessage({ message: { raw: digest } });
      });
      return { ...u, sig: { alg: 'secp256k1-eip191', value } };
    },

    async signSeal(agentId, txXdr, networkPassphrase) {
      if (networkPassphrase !== TESTNET.passphrase) throw vaultRefusal('wrong_network');
      let tx: Transaction;
      let shape: ReturnType<typeof sealShape>;
      try {
        const parsed = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
        if ('innerTransaction' in parsed) throw new Error('fee bump');
        tx = parsed as Transaction;
        shape = sealShape(tx);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (!shape || shape.maxTime > Math.floor(now().getTime() / 1000) + SEAL_MAX_VALIDITY_S) throw vaultRefusal('bad_payload');
      const digest = tx.hash();
      const lim = await limits();
      const publicKey = await sql.begin(async (q) => {
        await q`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await q`select a.status, k.public_key from app.agents a
                              left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'stellar' and k.destroyed_at is null
                              where a.id = ${agentId}`) as { status: string; public_key: string | null }[];
        const a = rows[0];
        if (!a?.public_key) throw vaultRefusal('no_key');
        // A paused agent's last checks may still be in the queue; a revoked one seals nothing.
        if (a.status !== 'active' && a.status !== 'paused') throw vaultRefusal('not_active');
        if (shape.agent !== a.public_key) throw vaultRefusal('wrong_wallet');
        const [c] = (await q`select count(*)::int as n from keyvault.signatures
                             where agent_id = ${agentId} and kind = 'seal' and at >= date_trunc('day', now(), 'UTC')`) as { n: number }[];
        if (c!.n >= lim.sealsPerAgentDay) throw vaultRefusal('over_day_cap');
        await q`insert into keyvault.signatures (agent_id, kind, digest) values (${agentId}, 'seal', ${digest.toString('hex')})`;
        return a.public_key;
      });
      return (await sign(agentId, digest, publicKey)).toString('base64');
    },

    async signClose(agentId, txXdr, networkPassphrase) {
      if (networkPassphrase !== TESTNET.passphrase) throw vaultRefusal('wrong_network');
      let tx: Transaction;
      let shape: ReturnType<typeof closeShape>;
      try {
        const parsed = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
        if ('innerTransaction' in parsed) throw new Error('fee bump');
        tx = parsed as Transaction;
        shape = closeShape(tx);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (!shape || shape.maxTime > Math.floor(now().getTime() / 1000) + CLOSE_MAX_VALIDITY_S) throw vaultRefusal('bad_payload');
      const a = await agent(agentId);
      // Only after the owner deleted the agent: a live agent's wallet is never emptied or closed.
      if (a.status !== 'revoked') throw vaultRefusal('not_deleted');
      if (shape.agent !== a.public_key) throw vaultRefusal('wrong_wallet');
      // The money goes to the owner, and nowhere else: an api that is taken over can close a deleted agent's wallet, never
      // empty it into its own. The owner is the one the vault pinned at bind (keyvault.keys.owner_address, migration 0050),
      // never app.users.owner_address or app.agents.user_id: the api can rewrite both. No pin, no sweep.
      // A merge moves only XLM the sweeps left (none, normally): to a pinned G owner, else the sponsor.
      const owner = a.pinned_owner;
      if (shape.kind === 'sweep' && (!owner || shape.to !== owner)) throw vaultRefusal('wrong_owner');
      if (shape.kind === 'merge') {
        const allowed = owner && /^G[A-Z2-7]{55}$/.test(owner) ? owner : sponsor?.publicKey;
        if (!allowed || shape.destination !== allowed) throw vaultRefusal('wrong_owner');
      }
      const digest = tx.hash();
      // Not a payment: the day caps never count it (it moves what is left, to the owner).
      await sql`insert into keyvault.signatures (agent_id, kind, digest) values (${agentId}, 'close', ${digest.toString('hex')})`;
      return (await sign(agentId, digest, a.public_key)).toString('base64');
    },

    async signReserve(agentId, txXdr, networkPassphrase) {
      if (networkPassphrase !== TESTNET.passphrase) throw vaultRefusal('wrong_network');
      let tx: Transaction;
      let shape: ReturnType<typeof reserveShape>;
      try {
        const parsed = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
        if ('innerTransaction' in parsed) throw new Error('fee bump');
        tx = parsed as Transaction;
        shape = reserveShape(tx);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      if (!shape || shape.maxTime > Math.floor(now().getTime() / 1000) + RESERVE_MAX_VALIDITY_S) throw vaultRefusal('bad_payload');
      // Only the platform's own sponsor: the agent's reserves never move to, or come from, anyone else.
      if (!sponsor || shape.sponsor !== sponsor.publicKey) throw vaultRefusal('bad_payload');
      const digest = tx.hash();
      const publicKey = await sql.begin(async (q) => {
        await q`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, hashtext(${agentId}::text))`;
        const rows = (await q`select a.status, a.reserve_state, a.pays_own_fees, a.reserve_repay_stroops::text as repay, k.public_key from app.agents a
                              left join keyvault.keys k on k.agent_id = a.id and k.chain_family = 'stellar' and k.destroyed_at is null
                              where a.id = ${agentId}`) as { status: string; reserve_state: string; pays_own_fees: boolean; repay: string | null; public_key: string | null }[];
        const a = rows[0];
        if (!a?.public_key) throw vaultRefusal('no_key');
        if (shape.agent !== a.public_key) throw vaultRefusal('wrong_wallet');
        if (shape.kind === 'handover' || shape.kind === 'topup') {
          // A live agent buys its reserves once, or a fee float when its own ran low, with its own USDC, for its own account
          // (the shape pins both). A handover pays the sponsor back exactly what the row says it fronted, or nothing.
          if (a.status !== 'active' && a.status !== 'paused') throw vaultRefusal('not_active');
          if (shape.kind === 'handover') {
            if (a.reserve_state !== 'due') throw vaultRefusal('bad_payload');
            if (shape.repayStroops !== 0n && shape.repayStroops !== BigInt(a.repay ?? -1)) throw vaultRefusal('bad_payload');
          } else if (a.reserve_state !== 'self_paid' || !a.pays_own_fees) throw vaultRefusal('bad_payload');
          const [c] = (await q`select count(*)::int as n from keyvault.signatures
                               where agent_id = ${agentId} and kind = 'reserve' and at >= date_trunc('day', now(), 'UTC')`) as { n: number }[];
          if (c!.n >= HANDOVERS_PER_AGENT_DAY) throw vaultRefusal('over_day_cap');
        } else if (a.status !== 'revoked') {
          // Handing the reserves back frees the agent's XLM for the closer's sweep: only once the owner deleted it.
          throw vaultRefusal('not_deleted');
        }
        await q`insert into keyvault.signatures (agent_id, kind, digest) values (${agentId}, 'reserve', ${digest.toString('hex')})`;
        return a.public_key;
      });
      return (await sign(agentId, digest, publicKey)).toString('base64');
    },

    async sponsorPublicKey() {
      if (!sponsor) throw vaultRefusal('no_key');
      return sponsor.publicKey;
    },

    async signSponsorTx(txXdr, networkPassphrase) {
      if (!sponsor) throw vaultRefusal('no_key');
      if (networkPassphrase !== TESTNET.passphrase) throw vaultRefusal('wrong_network');
      let checked: ReturnType<SponsorPolicy['check']>;
      try {
        checked = sponsor.policy.check(txXdr, networkPassphrase);
      } catch {
        throw vaultRefusal('bad_payload');
      }
      const fee = BigInt(checked.tx.fee);
      const txHash = checked.tx.hash().toString('hex');
      const lim = await limits();
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${VAULT_LOCK_NAMESPACE}, ${SPONSOR_LOCK_KEY})`;
        const [s] = (await tx`select coalesce(sum(fee_stroops), 0)::text as day from keyvault.sponsor_signatures
                              where at >= date_trunc('day', now(), 'UTC')`) as { day: string }[];
        if (BigInt(s!.day) + fee > lim.sponsorDayFeeStroops) throw vaultRefusal('over_day_cap');
        if (checked.kind === 'credit') {
          // Only a live hosted agent with its own key, never one whose reserves are still due (a credit must not pay them),
          // except one paused for want of funds: on testnet the credit is its first funding (agents/credit.ts),
          // at most once per VAULT_CREDIT_EVERY_H hours each and VAULT_CREDITS_PER_DAY in all.
          const [a] = (await tx`select a.id from keyvault.keys k join app.agents a on a.id = k.agent_id
                                where k.public_key = ${checked.creditTo!} and k.chain_family = 'stellar' and k.destroyed_at is null
                                  and a.deleted_at is null
                                  and ((a.status = 'active' and a.reserve_state <> 'due') or (a.status = 'paused' and a.paused_for_funds))`) as { id: string }[];
          if (!a) throw vaultRefusal('not_active');
          const [c] = (await tx`select count(*) filter (where agent_id = ${a.id} and at >= now() - ${lim.creditEveryH} * interval '1 hour')::int as mine,
                                       count(*) filter (where at >= date_trunc('day', now(), 'UTC'))::int as day
                                from keyvault.signatures where kind = 'credit' and at >= now() - interval '2 days'`) as { mine: number; day: number }[];
          if (c!.mine > 0 || c!.day >= lim.creditsPerDay) throw vaultRefusal('over_day_cap');
          await tx`insert into keyvault.signatures (agent_id, kind, digest) values (${a.id}, 'credit', ${txHash})`;
        }
        // Counted before it is signed, like payments.
        await tx`insert into keyvault.sponsor_signatures (kind, tx_hash, fee_stroops) values (${checked.kind}, ${txHash}, ${fee.toString()})`;
      });
      return sponsor.signTransaction(txXdr, networkPassphrase);
    },
  };
}
