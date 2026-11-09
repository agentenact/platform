import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { freshDb } from './support/db.js';
import { contractAddress, insertAgent, insertUser } from './support/fixtures.js';

describe('db', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());

  it('migrations create the onboarding and runtime tables in schema app', async () => {
    const rows = (await sql`select table_name from information_schema.tables where table_schema = 'app' order by table_name`) as { table_name: string }[];
    expect(rows.map((r) => r.table_name)).toEqual(['access_tokens', 'agent_skill_sets', 'agent_specs', 'agents', 'builder_usage', 'chat_sessions', 'chat_turns', 'check_days', 'check_log', 'check_seals', 'draft_handoffs', 'funds_alerts', 'funds_snapshots', 'karma_snapshot', 'leases', 'memory', 'model_usage', 'ops_settings', 'provision_starts', 'rate_windows', 'records', 'runs', 'services', 'sign_requests', 'skill_approvals', 'skill_set_items', 'skill_sets', 'skills', 'spend', 'triggers', 'users']);
  });

  it('spend refuses an amount over the per-call cap, a non-G payee and an unknown decision', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    const [run] = (await sql`insert into app.runs (agent_id, mode) values (${agentId}, 'chat') returning id`) as { id: string }[];
    const payee = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
    await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc) values (${agentId}, ${run!.id}, 'https://s.example/a', ${payee}, 0.05)`;
    await expect(Promise.resolve(sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.0500001)`)).rejects.toThrow(/spend_amount_usdc_check/);
    await expect(Promise.resolve(sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc) values (${agentId}, ${run!.id}, 'u', 'CABC', 0.01)`)).rejects.toThrow(/spend_payee_check/);
    await expect(Promise.resolve(sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'maybe')`)).rejects.toThrow(/spend_decision_check/);
  });

  it('spend: a settled row needs a tx hash, and a tx hash is unique', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    const [run] = (await sql`insert into app.runs (agent_id, mode) values (${agentId}, 'chat') returning id`) as { id: string }[];
    const payee = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
    const tx = 'a'.repeat(64);
    await expect(Promise.resolve(sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'settled')`)).rejects.toThrow(/spend_settled_needs_tx/);
    await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision, tx_hash) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'settled', ${tx})`;
    await expect(Promise.resolve(sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision, tx_hash) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'unknown', ${tx})`)).rejects.toThrow(/spend_tx_hash_unique/);
    await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'unknown')`;
    await sql`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, decision) values (${agentId}, ${run!.id}, 'u', ${payee}, 0.01, 'unknown')`;
  });

  it('a new user starts with zero daily usage and an epoch reset', async () => {
    const id = await insertUser(sql);
    const [u] = (await sql`select daily_tokens, daily_runs, daily_reset_at from app.users where id = ${id}`) as { daily_tokens: number; daily_runs: number; daily_reset_at: Date }[];
    expect([u!.daily_tokens, u!.daily_runs, u!.daily_reset_at.getTime()]).toEqual([0, 0, 0]);
  });

  it('stores a JS array param as a jsonb array (runs.steps, services.tools rely on it)', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    const steps = [{ n: 1, tools: ['web_read'], inputTokens: 10, outputTokens: 2, finishReason: 'tool-calls' }];
    const [r] = (await sql`insert into app.runs (agent_id, mode, steps) values (${agentId}, 'chat', ${steps}) returning steps, jsonb_typeof(steps) as kind`) as { steps: unknown; kind: string }[];
    expect(r!.kind).toBe('array');
    expect(r!.steps).toEqual(steps);
  });

  it('runs refuse an unknown mode or status and a malformed settlement hash', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    await expect(Promise.resolve(sql`insert into app.runs (agent_id, mode) values (${agentId}, 'build')`)).rejects.toThrow(/runs_mode_check/);
    await expect(Promise.resolve(sql`insert into app.runs (agent_id, mode, status) values (${agentId}, 'chat', 'paused')`)).rejects.toThrow(/runs_status_check/);
    await expect(Promise.resolve(sql`insert into app.runs (agent_id, mode, settlement_tx) values (${agentId}, 'service', 'XYZ')`)).rejects.toThrow(/runs_settlement_tx_check/);
  });

  it('memory keys are constrained and unique per agent', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    await sql`insert into app.memory (agent_id, key, value) values (${agentId}, 'city', 'Izmir')`;
    await expect(Promise.resolve(sql`insert into app.memory (agent_id, key, value) values (${agentId}, 'city', 'Ankara')`)).rejects.toThrow(/memory_pkey/);
    await expect(Promise.resolve(sql`insert into app.memory (agent_id, key, value) values (${agentId}, 'Bad Key', 'x')`)).rejects.toThrow(/memory_key_check/);
  });

  it('round-trips jsonb as an object, bytea as bytes, timestamptz as Date', async () => {
    const userId = await insertUser(sql, { ownerAddress: contractAddress(7) });
    const credential = { credentialId: 'abc', publicKey: 'BAEC', contractId: contractAddress(7), createdAt: 1, isPrimary: true };
    await sql`update app.users set passkey_credential = ${credential} where id = ${userId}`;
    const [u] = (await sql`select passkey_credential, jsonb_typeof(passkey_credential) as kind, created_at from app.users where id = ${userId}`) as { passkey_credential: unknown; kind: string; created_at: unknown }[];
    expect(u!.kind).toBe('object'); // an object param is stored as a jsonb object, not a double-encoded string
    expect(u!.passkey_credential).toEqual(credential);
    expect(u!.created_at).toBeInstanceOf(Date);

    const agentId = await insertAgent(sql, userId);
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    await sql`insert into keyvault.keys (agent_id, public_key, ciphertext, nonce, key_version) values (${agentId}, 'G', ${bytes}, ${bytes}, 1)`;
    const [k] = (await sql`select ciphertext from keyvault.keys where agent_id = ${agentId}`) as { ciphertext: Uint8Array }[];
    expect(k!.ciphertext).toBeInstanceOf(Uint8Array); // a Buffer, which is a Uint8Array
    expect(Buffer.from(k!.ciphertext).equals(bytes)).toBe(true);

    const [a] = (await sql`select provision_state from app.agents where id = ${agentId}`) as { provision_state: unknown }[];
    expect(a!.provision_state).toEqual({ step: 'pending', attempts: [] });
  });

  it('allows several non-revoked agents per user (the ceiling is the api\'s); a creation key is unique per user', async () => {
    const userId = await insertUser(sql);
    await insertAgent(sql, userId);
    await insertAgent(sql, userId);
    const key = crypto.randomUUID();
    await sql`insert into app.agents (user_id, name, creation_key) values (${userId}, 'k', ${key})`;
    await expect(Promise.resolve(sql`insert into app.agents (user_id, name, creation_key) values (${userId}, 'k2', ${key})`)).rejects.toThrow(/agents_creation_key/);
    // Another user may use the same key: it only names a create within one account.
    await sql`insert into app.agents (user_id, name, creation_key) values (${await insertUser(sql)}, 'k', ${key})`;
  });

  it('allows one live key per agent', async () => {
    const agentId = await insertAgent(sql, await insertUser(sql));
    await sql`insert into keyvault.keys (agent_id, public_key, ciphertext, nonce, key_version) values (${agentId}, 'G1', ${Buffer.alloc(1)}, ${Buffer.alloc(1)}, 1)`;
    // Promise.resolve: a raw Bun.sql query is a lazy thenable that expect().rejects never awaits (the test hangs).
    await expect(Promise.resolve(sql`insert into keyvault.keys (agent_id, public_key, ciphertext, nonce, key_version) values (${agentId}, 'G2', ${Buffer.alloc(1)}, ${Buffer.alloc(1)}, 1)`)).rejects.toThrow(/keys_one_live_per_agent/);
  });
});
