import { afterAll, describe, expect, it } from 'bun:test';
import { TEMPLATE_DB_NAME, freshDb, templateNameFor, templateStats } from './support/db.js';

const dbs: Array<{ drop: () => Promise<void> }> = [];
afterAll(async () => {
  for (const d of dbs) await d.drop();
});

describe('template database', () => {
  it('two freshDb calls build the template at most once', async () => {
    const before = templateStats().builds;
    const a = await freshDb();
    const b = await freshDb();
    dbs.push(a, b);
    expect(templateStats().builds - before).toBeLessThanOrEqual(1);
    for (const d of [a, b]) {
      const [row] = await d.sql`select count(*)::int as n from app.users`;
      expect(row?.n).toBe(0);
    }
  });

  it('changing a migration file changes the template name', () => {
    const a = templateNameFor(['create table a ();', 'create table b ();']);
    const b = templateNameFor(['create table a ();', 'create table b (x int);']);
    expect(a).not.toBe(b);
    expect(a.startsWith(`${TEMPLATE_DB_NAME}_`)).toBe(true);
    expect(templateNameFor(['create table a ();', 'create table b ();'])).toBe(a);
  });

  it('the template database is never connected to after build', async () => {
    const a = await freshDb();
    dbs.push(a);
    const rows = await a.sql`select 1 from pg_stat_activity where datname like ${TEMPLATE_DB_NAME + '%'}`;
    expect(rows.length).toBe(0);
  });
});
