import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import type { Db } from '../src/db/index.js';
import { createRecords } from '../src/records/index.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';
import { signedRecord } from './support/records.js';

describe('records', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());

  async function agent() {
    const kp = Keypair.random();
    const userId = await insertUser(sql);
    const id = await insertAgent(sql, userId, { status: 'active', stellarAddress: kp.publicKey() });
    return { id, kp };
  }
  const tx = () => crypto.randomUUID().replaceAll('-', '').repeat(2);

  it('save then get round-trips', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const t = tx();
    const rec = await signedRecord(a.kp, t);
    expect(await records.save(a.id, null, t, rec)).toBe(true);
    expect(await records.get(a.id, t)).toEqual(rec);
  });

  it('save is idempotent', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const t = tx();
    const rec = await signedRecord(a.kp, t);
    expect(await records.save(a.id, null, t, rec)).toBe(true);
    expect(await records.save(a.id, null, t, rec)).toBe(true);
    expect(((await sql`select count(*)::int as n from app.records where tx_hash = ${t}`) as { n: number }[])[0]!.n).toBe(1);
  });

  it('a record whose settlement.ref differs from the tx is refused', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const t = tx();
    const rec = await signedRecord(a.kp, tx());
    expect(await records.save(a.id, null, t, rec)).toBe(false);
    expect(await records.get(a.id, t)).toBeNull();
  });

  it('a record signed by another address than the agent\'s is refused', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const t = tx();
    const rec = await signedRecord(Keypair.random(), t);
    expect(await records.save(a.id, null, t, rec)).toBe(false);
    expect(await records.get(a.id, t)).toBeNull();
  });

  it('get for another agent\'s tx is null, and another agent cannot claim a stored tx', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const b = await agent();
    const t = tx();
    expect(await records.save(a.id, null, t, await signedRecord(a.kp, t))).toBe(true);
    expect(await records.get(b.id, t)).toBeNull();
    expect(await records.save(b.id, null, t, await signedRecord(b.kp, t))).toBe(false);
    expect(await records.get(a.id, t)).not.toBeNull();
  });

  it('refuses a malformed tx, a malformed record and an unknown agent without throwing', async () => {
    const records = createRecords(sql);
    const a = await agent();
    const rec = await signedRecord(a.kp, tx());
    expect(await records.save(a.id, null, 'nope', rec)).toBe(false);
    expect(await records.save(a.id, null, rec.settlement.ref, { ...rec, v: '9' } as never)).toBe(false);
    expect(await records.save(crypto.randomUUID(), null, rec.settlement.ref, rec)).toBe(false);
    expect(await records.get(a.id, 'nope')).toBeNull();
  });
});
