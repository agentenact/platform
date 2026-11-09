import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { MAX_ORPHANS } from '../src/gateway/app.js';
import { checkAgent, unblockAgent, unblockStatement } from '../src/provision/unblock.js';
import { freshDb } from './support/db.js';

const orphan = (n: number) => ({ publicKey: `G${'A'.repeat(55)}`, attempt: n, txs: { account: 'a'.repeat(64) } });

describe('operator unblock (orphan limit)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let userId: string;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const [u] = (await sql`insert into app.users (id, email) values (gen_random_uuid(), 'unblock@example.com') returning id`) as { id: string }[];
    userId = u!.id;
  });
  afterAll(() => drop());

  const agentWith = async (state: object) => {
    await sql`delete from app.agents where user_id = ${userId}`;
    const [a] = (await sql`insert into app.agents (user_id, name, status, provision_state) values (${userId}, 'u', 'provisioning', ${state}::jsonb) returning id`) as { id: string }[];
    return a!.id;
  };
  const stateOf = async (id: string) => ((await sql`select provision_state from app.agents where id = ${id}`) as { provision_state: Record<string, unknown> }[])[0]!.provision_state;

  it('moves the orphans into the archive (keeping earlier ones) so a retry is allowed again', async () => {
    const id = await agentWith({ step: 'failed', orphans: [orphan(1), orphan(2), orphan(3)], orphans_archived: [orphan(0)] });
    expect(await unblockAgent(sql, id)).toBe('unblocked');
    const s = await stateOf(id);
    expect(s.orphans).toBeUndefined();
    expect((s.orphans_archived as unknown[]).length).toBe(4);
    expect(typeof s.unblocked_at).toBe('string');
    expect(s.step).toBe('failed');
  });

  it('never unblocks an agent bound under a foreign owner (a real security case)', async () => {
    const id = await agentWith({ step: 'failed', error: 'bound_foreign_owner', orphans: [orphan(1), orphan(2), orphan(3)] });
    expect(await unblockAgent(sql, id)).toBe('refused');
    expect(((await stateOf(id)).orphans as unknown[]).length).toBe(3);
  });

  it('reports nothing to do and unknown ids without writing', async () => {
    const id = await agentWith({ step: 'failed' });
    expect(await unblockAgent(sql, id)).toBe('nothing_to_do');
    expect(await unblockAgent(sql, crypto.randomUUID())).toBe('not_found');
  });

  it('the check reports what an unblock would do and writes nothing', async () => {
    const id = await agentWith({ step: 'failed', orphans: [orphan(1)] });
    expect(await checkAgent(sql, id)).toBe('would_unblock');
    expect(((await stateOf(id)).orphans as unknown[]).length).toBe(1);
    expect(await checkAgent(sql, await agentWith({ step: 'failed', error: 'bound_foreign_owner', orphans: [orphan(1)] }))).toBe('refused');
    expect(await checkAgent(sql, await agentWith({ step: 'active' }))).toBe('nothing_to_do');
    expect(await checkAgent(sql, crypto.randomUUID())).toBe('not_found');
  });

  it('builds its statement only from a valid uuid', () => {
    expect(() => unblockStatement("x'; drop table app.agents; --")).toThrow();
    expect(unblockStatement('00000000-0000-4000-8000-000000000000')).toContain("'00000000-0000-4000-8000-000000000000'");
  });

  it('the orphan limit is 3', () => {
    expect(MAX_ORPHANS).toBe(3);
  });
});
