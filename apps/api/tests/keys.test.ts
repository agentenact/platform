import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import type { Db } from '../src/db/index.js';
import { createKeys } from '../src/keys/index.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const master = () => ({ KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });

describe('keys', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  const agent = async () => insertAgent(sql, await insertUser(sql));

  it('generate → withSecret hands back the same keypair; the row holds no secret', async () => {
    const keys = createKeys(sql, master());
    const id = await agent();
    const { publicKey } = await keys.generate(id);
    const stored = await keys.withSecret(id, async (kp: Keypair) => {
      expect(kp.publicKey()).toBe(publicKey);
      const [row] = (await sql`select ciphertext, nonce, key_version from keyvault.keys where agent_id = ${id}`) as { ciphertext: Uint8Array; nonce: Uint8Array; key_version: number }[];
      const ct = Buffer.from(row!.ciphertext);
      expect(ct.length).toBe(32 + 16); // seed + GCM tag
      expect(Buffer.from(row!.nonce).length).toBe(12);
      expect(row!.key_version).toBe(1);
      expect(ct.includes(kp.rawSecretKey())).toBe(false);
      expect(ct.toString('latin1')).not.toContain(kp.secret());
      return ct;
    });
    expect(stored.length).toBe(48);
    expect(await keys.publicKey(id)).toBe(publicKey);
  });

  it('a keypair that escapes withSecret has a wiped secret', async () => {
    const keys = createKeys(sql, master());
    const id = await agent();
    await keys.generate(id);
    const { publicKey: pub } = { publicKey: (await keys.publicKey(id))! };
    const leaked = await keys.withSecret(id, async (k: Keypair) => k);
    expect(leaked.rawSecretKey().every((b) => b === 0)).toBe(true);
    const msg = Buffer.from('hello');
    expect(Keypair.fromPublicKey(pub).verify(msg, leaked.sign(msg))).toBe(false);
  });

  it('agent_id is bound as AAD: a ciphertext moved to another agent does not decrypt', async () => {
    const keys = createKeys(sql, master());
    const a = await agent();
    const b = await agent();
    await keys.generate(a);
    await sql`insert into keyvault.keys (agent_id, public_key, ciphertext, nonce, key_version)
              select ${b}, public_key, ciphertext, nonce, key_version from keyvault.keys where agent_id = ${a}`;
    await expect(keys.withSecret(b, async (k) => k)).rejects.toThrow(`keys: cannot decrypt the key of agent ${b}`);
  });

  it('a different master secret cannot decrypt', async () => {
    const id = await agent();
    await createKeys(sql, master()).generate(id);
    await expect(createKeys(sql, master()).withSecret(id, async (k) => k)).rejects.toThrow(/cannot decrypt/);
  });

  it('refuses a second live key; destroy zeroes the row and blocks withSecret; a new key can follow', async () => {
    const keys = createKeys(sql, master());
    const id = await agent();
    const first = await keys.generate(id);
    await expect(keys.generate(id)).rejects.toThrow(/already has a live key/);
    await keys.destroy(id);
    const [row] = (await sql`select ciphertext, nonce, destroyed_at from keyvault.keys where agent_id = ${id}`) as { ciphertext: Uint8Array; nonce: Uint8Array; destroyed_at: Date | null }[];
    expect(Buffer.from(row!.ciphertext).length).toBe(0);
    expect(Buffer.from(row!.nonce).length).toBe(0);
    expect(row!.destroyed_at).toBeInstanceOf(Date);
    await expect(keys.withSecret(id, async (k) => k)).rejects.toThrow(/has no live key/);
    const second = await keys.generate(id);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it('no error message ever contains the secret, and none chains a cause', async () => {
    const env = master();
    const keys = createKeys(sql, env);
    const id = await agent();
    await keys.generate(id);
    const secret = await keys.withSecret(id, async (k) => k.secret());
    const errors: Error[] = [];
    const grab = (e: Error) => errors.push(e);
    await keys.withSecret(id, async () => { throw new Error('downstream failed'); }).catch(grab);
    await createKeys(sql, master()).withSecret(id, async (k) => k).catch(grab);
    await sql`update keyvault.keys set key_version = 2 where agent_id = ${id}`;
    await keys.withSecret(id, async (k) => k).catch(grab);
    await sql`update keyvault.keys set key_version = 1 where agent_id = ${id}`;
    const other = await agent();
    await keys.generate(other);
    await sql`update keyvault.keys set public_key = (select public_key from keyvault.keys where agent_id = ${id}) where agent_id = ${other}`.catch(() => {});
    await keys.withSecret(other, async (k) => k).catch(grab);
    await sql`update keyvault.keys set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where agent_id = ${id}`;
    await keys.withSecret(id, async (k) => k).catch(grab);
    expect(errors.length).toBe(5);
    for (const e of errors) {
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain(env.KEYS_MASTER_SECRET);
      expect(e.cause).toBeUndefined();
    }
  });

  it('any tampered or truncated row fails to decrypt', async () => {
    const keys = createKeys(sql, master());
    const cases: Record<string, string> = {
      ciphertext: `ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)`,
      tag: `ciphertext = set_byte(ciphertext, 47, get_byte(ciphertext, 47) # 1)`,
      nonce: `nonce = set_byte(nonce, 0, get_byte(nonce, 0) # 1)`,
      truncated: `ciphertext = substring(ciphertext from 1 for 40)`,
      'short nonce': `nonce = substring(nonce from 1 for 8)`,
    };
    for (const [name, set] of Object.entries(cases)) {
      const id = await agent();
      await keys.generate(id);
      await sql.unsafe(`update keyvault.keys set ${set} where agent_id = '${id}'`);
      await expect(keys.withSecret(id, async (k) => k), name).rejects.toThrow(/cannot decrypt/);
    }
  });

  it('agent id case does not matter for the AAD', async () => {
    const keys = createKeys(sql, master());
    const id = await agent();
    const { publicKey } = await keys.generate(id.toUpperCase());
    expect(await keys.withSecret(id.toLowerCase(), async (k) => k.publicKey())).toBe(publicKey);
  });

  it('a unique violation on the live-key index becomes the friendly error (live-check raced)', async () => {
    const real = createKeys(sql, master());
    const id = await agent();
    await real.generate(id);
    // The live-check sees nothing, as if another generate had not committed yet; everything else is real.
    const blind = ((strings: TemplateStringsArray, ...vals: unknown[]) =>
      /from app\.keys/.test(strings.join('?')) ? Promise.resolve([]) : sql(strings, ...vals)) as unknown as Db;
    await expect(createKeys(blind, master()).generate(id)).rejects.toThrow(/already has a live key/);
  });

  it('two concurrent generates: exactly one wins, the other fails', async () => {
    const keys = createKeys(sql, master());
    const id = await agent();
    const results = await Promise.allSettled([keys.generate(id), keys.generate(id)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((rejected[0]!.reason as Error).message).toMatch(/already has a live key/);
  });

  it('refuses a missing or short master secret', () => {
    expect(() => createKeys(sql, {})).toThrow('keys: KEYS_MASTER_SECRET is not set');
    expect(() => createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(16).toString('base64') })).toThrow(/at least 32 bytes/);
  });

  it('refuses a non-canonical base64 master secret without echoing it', () => {
    const bad = `${randomBytes(32).toString('base64')}!!`;
    try {
      createKeys(sql, { KEYS_MASTER_SECRET: bad });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/not canonical base64/);
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it('webhookSecret is per agent, stable, and depends on the master secret', async () => {
    const m = master();
    const keys = createKeys(sql, m);
    const id = await agent();
    const other = await agent();
    const s = keys.webhookSecret(id);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.webhookSecret(id.toUpperCase())).toBe(s);
    expect(createKeys(sql, m).webhookSecret(id)).toBe(s);
    expect(keys.webhookSecret(other)).not.toBe(s);
    expect(createKeys(sql, master()).webhookSecret(id)).not.toBe(s);
  });
});
