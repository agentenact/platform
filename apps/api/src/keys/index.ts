/**
 * `keys`: the only unit that reads KEYS_MASTER_SECRET. Agent seeds are sealed with AES-256-GCM
 * under a key derived by HKDF-SHA256, with agent_id::text (the id as Postgres renders it) as AAD:
 * a row moved to another agent does not open. The keypair leaves only through `withSecret`, and only provision calls it in P2.
 *
 * Also derives each agent's webhook HMAC secret (HKDF info agentenact/webhook/v1); nothing is stored.
 *
 * An agent holds one live key per chain family (keyvault.keys.chain_family, migration 0025): its Stellar ed25519
 * seed, and, created on first use, an EVM secp256k1 key. Both are sealed under the same master key; the EVM key's AAD
 * is agent_id::text || '|evm', so a row moved to another agent, or relabelled as another family, does not open.
 * The Stellar AAD stays agent_id::text alone (rows sealed before 0025 keep opening). A Solana ed25519 seed (migration 0041)
 * is sealed the same way with AAD agent_id::text || '|solana'; its public_key is the base58 address.
 *
 * What is wiped: the decrypted seed buffer, and the keypair's raw secret buffer once the callback
 * settles. A keypair that escaped the callback holds an all-zero seed: any later signature is made
 * with that zero seed and does not verify for the agent's key.
 * What cannot be wiped (JS has no way to): the KEYS_MASTER_SECRET string, any string the callback
 * obtains via `kp.secret()`, the Buffer pool, and copies made inside the SDK or the runtime. For an EVM key also
 * the hex string viem takes (`privateKeyToAccount` has no bytes form) and the account it builds.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { solanaAddressOf } from 'agentenact/adapters/solana';
import type { Db } from '../db/index.js';

const KEY_VERSION = 1;
const SALT = Buffer.from('agentenact-cloud/keys');
const INFO = Buffer.from('agentenact/keys/v1');
const WEBHOOK_INFO = Buffer.from('agentenact/webhook/v1');
const TAG_BYTES = 16;
const SEED_BYTES = 32;
const NONCE_BYTES = 12;

export type ChainFamily = 'stellar' | 'evm' | 'solana';

export interface Keys {
  generate(agentId: string): Promise<{ publicKey: string }>;
  /** The agent's EVM key: created on the first call, the same address after. Lowercase. */
  ensureEvm(agentId: string): Promise<{ address: string }>;
  /** The agent's live EVM address (lowercase), or null before ensureEvm. */
  evmAddress(agentId: string): Promise<string | null>;
  withEvmAccount<T>(agentId: string, fn: (account: PrivateKeyAccount) => Promise<T>): Promise<T>;
  /** The agent's Solana key: created on the first call, the same address (base58) after. */
  ensureSolana(agentId: string): Promise<{ address: string }>;
  /** The agent's live Solana address (base58), or null before ensureSolana. */
  solanaAddress(agentId: string): Promise<string | null>;
  /** The agent's Solana ed25519 seed (32 bytes), zeroed once `fn` settles. */
  withSolanaSeed<T>(agentId: string, fn: (seed: Uint8Array, address: string) => Promise<T>): Promise<T>;
  withSecret<T>(agentId: string, fn: (kp: Keypair) => Promise<T>): Promise<T>;
  /**
   * Zeroes the ciphertext and nonce and stamps destroyed_at, for every chain family of the agent. This is logical destruction only:
   * MVCC dead tuples, WAL and backups keep the old ciphertext until vacuum and expiry, so only
   * rotating KEYS_MASTER_SECRET truly destroys it.
   */
  destroy(agentId: string): Promise<void>;
  publicKey(agentId: string): Promise<string | null>;
  /** The agent's webhook HMAC secret (hex), derived from the master secret; nothing is stored (plan D6). */
  webhookSecret(agentId: string): string;
}

interface KeyRow {
  aid: string; // agent_id::text as Postgres renders it: the canonical AAD
  public_key: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  key_version: number;
}

export function createKeys(sql: Db, env: Record<string, string | undefined> = process.env): Keys {
  const master = env.KEYS_MASTER_SECRET;
  if (!master) throw new Error('keys: KEYS_MASTER_SECRET is not set');
  const ikm = Buffer.from(master, 'base64');
  if (ikm.toString('base64').replace(/=+$/, '') !== master.replace(/=+$/, '')) {
    ikm.fill(0);
    throw new Error('keys: KEYS_MASTER_SECRET is not canonical base64');
  }
  if (ikm.length < 32) {
    ikm.fill(0);
    throw new Error('keys: KEYS_MASTER_SECRET must decode to at least 32 bytes (base64)');
  }
  const key = Buffer.from(hkdfSync('sha256', ikm, SALT, INFO, 32));
  const webhookKey = Buffer.from(hkdfSync('sha256', ikm, SALT, WEBHOOK_INFO, 32));
  ikm.fill(0);

  const cannotDecrypt = (agentId: string) => new Error(`keys: cannot decrypt the key of agent ${agentId}`);
  const alreadyLive = (agentId: string) => new Error(`keys: agent ${agentId} already has a live key`);

  const aad = (canonicalId: string, family: ChainFamily) => Buffer.from(family === 'stellar' ? canonicalId : `${canonicalId}|${family}`);

  function seal(seed: Buffer, canonicalId: string, family: ChainFamily = 'stellar') {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    c.setAAD(aad(canonicalId, family));
    return { nonce, ciphertext: Buffer.concat([c.update(seed), c.final(), c.getAuthTag()]) };
  }

  function open(row: KeyRow, agentId: string, family: ChainFamily = 'stellar'): Buffer {
    const data = Buffer.from(row.ciphertext);
    const nonce = Buffer.from(row.nonce);
    if (data.length !== SEED_BYTES + TAG_BYTES || nonce.length !== NONCE_BYTES) throw cannotDecrypt(agentId);
    try {
      const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      d.setAAD(aad(row.aid, family));
      d.setAuthTag(data.subarray(SEED_BYTES));
      const pt = d.update(data.subarray(0, SEED_BYTES));
      try {
        d.final();
      } catch {
        pt.fill(0); // unauthenticated plaintext
        throw cannotDecrypt(agentId);
      }
      return pt;
    } catch {
      // Never chain the cause: it can carry buffers.
      throw cannotDecrypt(agentId);
    }
  }

  async function live(agentId: string, family: ChainFamily = 'stellar'): Promise<KeyRow | null> {
    const rows = (await sql`select agent_id::text as aid, public_key, ciphertext, nonce, key_version from keyvault.keys
                            where agent_id = ${agentId} and chain_family = ${family} and destroyed_at is null`) as KeyRow[];
    return rows[0] ?? null;
  }

  async function openEvm<T>(row: KeyRow, agentId: string, fn: (account: PrivateKeyAccount) => Promise<T>): Promise<T> {
    if (row.key_version !== KEY_VERSION) throw new Error(`keys: unsupported key version ${row.key_version}`);
    const seed = open(row, agentId, 'evm');
    let account: PrivateKeyAccount;
    try {
      account = privateKeyToAccount(`0x${seed.toString('hex')}`);
    } catch {
      throw cannotDecrypt(agentId);
    } finally {
      seed.fill(0);
    }
    if (account.address.toLowerCase() !== row.public_key) throw new Error(`keys: the EVM key of agent ${agentId} does not match its address`);
    return fn(account);
  }

  return {
    async generate(agentId) {
      if (await live(agentId)) throw alreadyLive(agentId);
      const canonicalId = ((await sql`select ${agentId}::uuid::text as id`) as { id: string }[])[0]!.id;
      const kp = Keypair.random();
      try {
        const { nonce, ciphertext } = seal(kp.rawSecretKey(), canonicalId);
        const publicKey = kp.publicKey();
        try {
          await sql`insert into keyvault.keys (agent_id, public_key, ciphertext, nonce, key_version)
                    values (${agentId}, ${publicKey}, ${ciphertext}, ${nonce}, ${KEY_VERSION})`;
        } catch (e) {
          // Bun reports a PostgresError with code ERR_POSTGRES_SERVER_ERROR; the SQLSTATE is in errno.
          const err = e as { errno?: string };
          if (err.errno === '23505') throw alreadyLive(agentId);
          throw e;
        }
        return { publicKey };
      } finally {
        kp.rawSecretKey().fill(0);
      }
    },

    async withSecret(agentId, fn) {
      const row = await live(agentId);
      if (!row) throw new Error(`keys: agent ${agentId} has no live key`);
      if (row.key_version !== KEY_VERSION) throw new Error(`keys: unsupported key version ${row.key_version}`);
      const seed = open(row, agentId);
      let kp: Keypair;
      try {
        kp = Keypair.fromRawEd25519Seed(seed);
      } finally {
        seed.fill(0);
      }
      try {
        if (kp.publicKey() !== row.public_key) throw new Error(`keys: the key of agent ${agentId} does not match its public key`);
        return await fn(kp);
      } finally {
        kp.rawSecretKey().fill(0);
      }
    },

    async ensureEvm(agentId) {
      const existing = await live(agentId, 'evm');
      if (existing) return { address: existing.public_key };
      const canonicalId = ((await sql`select ${agentId}::uuid::text as id`) as { id: string }[])[0]!.id;
      // A uniform 32-byte secret is a valid secp256k1 key except with probability ~2^-128; viem throws on the rest.
      const seed = randomBytes(SEED_BYTES);
      try {
        const address = privateKeyToAccount(`0x${seed.toString('hex')}`).address.toLowerCase();
        const { nonce, ciphertext } = seal(seed, canonicalId, 'evm');
        try {
          await sql`insert into keyvault.keys (agent_id, chain_family, public_key, ciphertext, nonce, key_version)
                    values (${agentId}, 'evm', ${address}, ${ciphertext}, ${nonce}, ${KEY_VERSION})`;
        } catch (e) {
          // Two first calls at once: the other one won; its key is the agent's.
          if ((e as { errno?: string }).errno === '23505') {
            const won = await live(agentId, 'evm');
            if (won) return { address: won.public_key };
          }
          throw e;
        }
        return { address };
      } finally {
        seed.fill(0);
      }
    },

    async evmAddress(agentId) {
      return (await live(agentId, 'evm'))?.public_key ?? null;
    },

    async withEvmAccount(agentId, fn) {
      const row = await live(agentId, 'evm');
      if (!row) throw new Error(`keys: agent ${agentId} has no live EVM key`);
      return openEvm(row, agentId, fn);
    },

    async ensureSolana(agentId) {
      const existing = await live(agentId, 'solana');
      if (existing) return { address: existing.public_key };
      const canonicalId = ((await sql`select ${agentId}::uuid::text as id`) as { id: string }[])[0]!.id;
      const seed = randomBytes(SEED_BYTES);
      try {
        const address = await solanaAddressOf(seed);
        const { nonce, ciphertext } = seal(seed, canonicalId, 'solana');
        try {
          await sql`insert into keyvault.keys (agent_id, chain_family, public_key, ciphertext, nonce, key_version)
                    values (${agentId}, 'solana', ${address}, ${ciphertext}, ${nonce}, ${KEY_VERSION})`;
        } catch (e) {
          if ((e as { errno?: string }).errno === '23505') {
            const won = await live(agentId, 'solana');
            if (won) return { address: won.public_key };
          }
          throw e;
        }
        return { address };
      } finally {
        seed.fill(0);
      }
    },

    async solanaAddress(agentId) {
      return (await live(agentId, 'solana'))?.public_key ?? null;
    },

    async withSolanaSeed(agentId, fn) {
      const row = await live(agentId, 'solana');
      if (!row) throw new Error(`keys: agent ${agentId} has no live Solana key`);
      if (row.key_version !== KEY_VERSION) throw new Error(`keys: unsupported key version ${row.key_version}`);
      const seed = open(row, agentId, 'solana');
      try {
        if ((await solanaAddressOf(seed)) !== row.public_key) throw new Error(`keys: the Solana key of agent ${agentId} does not match its address`);
        return await fn(seed, row.public_key);
      } finally {
        seed.fill(0);
      }
    },

    async destroy(agentId) {
      await sql`update keyvault.keys set ciphertext = ''::bytea, nonce = ''::bytea, destroyed_at = now()
                where agent_id = ${agentId} and destroyed_at is null`;
    },

    async publicKey(agentId) {
      return (await live(agentId))?.public_key ?? null;
    },

    webhookSecret(agentId) {
      return createHmac('sha256', webhookKey).update(agentId.toLowerCase()).digest('hex');
    },
  };
}
