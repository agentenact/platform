import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createKarma } from '../src/discovery/karma.js';
import { createDiscovery } from '../src/discovery/queries.js';
import { EXPORT_NAMES, exportCsv, type ExportName } from '../src/discovery/export.js';
import { freshDb } from './support/db.js';

const G = (c: string) => `G${c.repeat(55)}`;
const NOW = new Date('2026-10-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
let n = 0;
const tx = () => (++n).toString(16).padStart(64, '0');

const HEADERS: Record<ExportName, string> = {
  agents: 'agent_id,owner,wallet,uri,registered_at,registered_tx,source,builder',
  payments: 'op_id,idx,tx_hash,agent_id,payer,payer_agent_id,amount_usdc,asset,at',
  'proven-sales': 'settlement_ref,agent_id,agent_address,digest,payer,amount_usdc,asset,settled_at,source',
  activity: 'agent_id,kind,ref,at',
};

/** minimal RFC 4180 parser for the tests */
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (q) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const units = (s: string): bigint => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 10_000_000n + BigInt(f.padEnd(7, '0'));
};

describe('discovery export', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  const ex = (name: ExportName, o: { includeExcluded?: boolean; maxRows?: number } = {}) => exportCsv(sql, name, { now: () => NOW, ...o }).then((r) => r.csv);

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  beforeEach(async () => {
    await sql`truncate discovery.meta, discovery.agents, discovery.registry_events, discovery.payments, discovery.proven_sales, discovery.selfpub, discovery.services, discovery.hidden, discovery.feed restart identity`;
  });

  const agent = (id: number, o: { uri?: string; builder?: string; wallet?: string | null } = {}) =>
    sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, registered_tx, registered_at)
        values (${id}, ${G(String.fromCharCode(65 + (id % 20)))}, ${o.wallet ?? null}, ${o.uri ?? ''}, 'event', ${o.builder ?? 'external'}, ${tx()}, ${ago(5 * HOUR)})`;
  const pay = (agentId: number, amt: number, o: { at?: string; counted?: boolean; payerAgent?: number | null } = {}) => {
    const t = tx();
    return sql`insert into discovery.payments (op_id, idx, agent_id, tx_hash, payer, payer_agent_id, payee, amount_units, asset, at, counted, excluded_reason)
      values (${'op' + t}, 0, ${agentId}, ${t}, ${G('P')}, ${o.payerAgent ?? null}, ${G('W')}, ${amt}, 'USDC:X', ${o.at ?? ago(MIN)}, ${o.counted ?? true}, ${o.counted === false ? 'owner' : null})`;
  };
  const sale = (agentId: number, at = ago(MIN)) => {
    const t = tx();
    return sql`insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at)
      values (${t}, ${G('S')}, ${agentId}, ${'d' + t}, ${{ secret: 'x' }}, 'hosted', ${G('P')}, 10000, 'USDC:X', ${at})`;
  };

  it('each export has its header and one line per row', async () => {
    await agent(1);
    await agent(2);
    await pay(1, 10_000);
    await sale(1);
    for (const name of EXPORT_NAMES) {
      const csv = await ex(name);
      expect(csv.split('\n')[0]).toBe(HEADERS[name]);
      expect(csv.endsWith('\n')).toBe(true);
      const rows = parse(csv);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) expect(r.length).toBe(HEADERS[name].split(',').length);
    }
    expect(parse(await ex('agents')).length).toBe(3);
    expect(parse(await ex('payments')).length).toBe(2);
    expect(parse(await ex('proven-sales')).length).toBe(2);
  });

  it('the exports reproduce every stats total', async () => {
    await agent(1);
    await agent(2);
    await agent(3);
    await pay(1, 10_000);
    await pay(2, 25_000_001, { payerAgent: 1 });
    await pay(2, 5_000_000, { counted: false });
    await pay(3, 7, { at: ago(3 * HOUR) });
    await sale(1);
    await sale(2, ago(4 * HOUR));
    const s = await createDiscovery(sql, { karma: createKarma(), now: () => NOW }).stats();

    const paid = parse(await ex('payments')).slice(1).reduce((a, r) => a + units(r[6]!), 0n);
    expect(paid).toBe(units(s.usdcTransfers));
    const provenPaid = parse(await ex('proven-sales')).slice(1).reduce((a, r) => a + units(r[5]!), 0n);
    expect(provenPaid).toBe(units(s.usdcProven));
    expect(parse(await ex('agents')).length - 1).toBe(s.agents);
    expect(parse(await ex('proven-sales')).length - 1).toBe(s.provenOutputs);
    const act = parse(await ex('activity')).slice(1);
    expect(new Set(act.map((r) => r[0])).size).toBe(s.activeLastHour);
    expect(s.activeLastHour).toBe(2); // agent 1 (received, sent, sale) and agent 2 (received); agent 3 is older than an hour
    // sent counts: agent 1 appears as a payer
    expect(act.some((r) => r[0] === '1' && r[1] === 'sent')).toBe(true);
  });

  it('the activity export drops registrations and binds, so its distinct agents equal activeLastHour', async () => {
    await agent(1);
    await agent(2);
    await agent(3);
    const ev = (id: number, kind: string) =>
      sql`insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at) values (${'e' + ++n}, ${id}, ${kind}, ${tx()}, 1, ${ago(MIN)})`;
    await ev(1, 'registered');
    await ev(2, 'wallet_bound');
    await sale(3);
    const s = await createDiscovery(sql, { karma: createKarma(), now: () => NOW }).stats();
    const act = parse(await ex('activity')).slice(1);
    expect(act.map((r) => r[1])).toEqual(['sale']);
    expect(new Set(act.map((r) => r[0])).size).toBe(s.activeLastHour);
    expect(s.activeLastHour).toBe(1);
  });

  it('excluded rows appear only with includeExcluded, with a reason', async () => {
    await agent(1);
    await pay(1, 10_000);
    await pay(1, 5_000_000, { counted: false });
    const plain = parse(await ex('payments'));
    expect(plain.length).toBe(2);
    expect(plain[0]!.length).toBe(9);
    const all = parse(await ex('payments', { includeExcluded: true }));
    expect(all[0]!.slice(-2)).toEqual(['counted', 'excluded_reason']);
    expect(all.length).toBe(3);
    const reasons = all.slice(1).map((r) => [r[9], r[10]]);
    expect(reasons).toContainEqual(['true', '']);
    expect(reasons).toContainEqual(['false', 'owner']);
  });

  it('quotes commas and quotes, and neutralizes formula-looking cells', async () => {
    await agent(1, { uri: '=HYPERLINK("http://x",a),b' });
    await agent(2, { uri: '+1' });
    await agent(3, { uri: '-1' });
    await agent(4, { uri: '@sum' });
    await agent(5, { uri: '\tx' });
    await agent(6, { uri: '\rx' });
    await agent(7, { uri: 'https://a/b?x=1,2' });
    const csv = await ex('agents');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",a),b"`);
    const byId = new Map(parse(csv).slice(1).map((r) => [r[0]!, r[3]!]));
    expect(byId.get('1')).toBe(`'=HYPERLINK("http://x",a),b`);
    expect(byId.get('2')).toBe("'+1");
    expect(byId.get('3')).toBe("'-1");
    expect(byId.get('4')).toBe("'@sum");
    expect(byId.get('5')).toBe("'\tx");
    expect(byId.get('6')).toBe("'\rx");
    expect(byId.get('7')).toBe('https://a/b?x=1,2');
  });

  it('neutralizes every string cell, not only uri', async () => {
    await sql`insert into discovery.agents (agent_id, owner, wallet, source, registered_tx) values (1, '=owner', '@w', 'event', '-tx')`;
    const row = parse(await ex('agents'))[1]!;
    expect(row[1]).toBe("'=owner");
    expect(row[2]).toBe("'@w");
    expect(row[5]).toBe("'-tx");
  });

  it('never includes self-published text', async () => {
    await agent(1, { builder: 'hosted' });
    await sql`insert into discovery.selfpub (agent_id, name, description, fetched_at) values (1, 'ZZZNAME', 'ZZZDESC', ${ago(MIN)})`;
    await sql`insert into discovery.services (agent_id, slug, description, price_usdc, first_seen_at, last_seen_at) values (1, 'zzzslug', 'ZZZSVC', '0.1', ${ago(HOUR)}, ${ago(MIN)})`;
    await sql`insert into discovery.feed (kind, agent_id, label, at, self_published, source_key) values ('service_opened', 1, 'ZZZLABEL', ${ago(MIN)}, true, 'k1')`;
    await pay(1, 10_000);
    await sale(1);
    for (const name of EXPORT_NAMES) {
      const csv = await ex(name);
      expect(csv).not.toContain('ZZZ');
      expect(csv).not.toContain('zzzslug');
    }
  });

  it('exports builder with the reader rules: stale or unverified hosted reads as external', async () => {
    await agent(1, { builder: 'hosted' }); // no selfpub row
    await agent(2, { builder: 'hosted' });
    await agent(3, { builder: 'hosted' });
    await agent(4, { builder: 'library' });
    await sql`insert into discovery.selfpub (agent_id, fetched_at) values (2, ${ago(2 * HOUR)}), (3, ${ago(10 * MIN)})`;
    const b = new Map(parse(await ex('agents')).slice(1).map((r) => [r[0]!, r[7]!]));
    expect(b.get('1')).toBe('external');
    expect(b.get('2')).toBe('external');
    expect(b.get('3')).toBe('hosted');
    expect(b.get('4')).toBe('library');
  });

  it('handles an empty index (header only)', async () => {
    for (const name of EXPORT_NAMES) expect(await ex(name)).toBe(HEADERS[name] + '\n');
  });

  it('orders activity newest first and the others oldest first', async () => {
    await agent(1);
    await agent(2);
    await pay(1, 1, { at: ago(30 * MIN) });
    await pay(2, 1, { at: ago(10 * MIN) });
    const act = parse(await ex('activity')).slice(1);
    expect(act.map((r) => r[0])).toEqual(['2', '1']);
    expect(parse(await ex('agents')).slice(1).map((r) => r[0])).toEqual(['1', '2']);
    expect(parse(await ex('payments')).slice(1).map((r) => r[3])).toEqual(['1', '2']);
  });

  it('a data uri is exported without its payload', async () => {
    const payload = Buffer.from(JSON.stringify({ name: 'ZZZNAME' })).toString('base64');
    await agent(1, { uri: `data:application/json;base64,${payload}` });
    await agent(2, { uri: 'data:application/json,{"name":"ZZZNAME"}' });
    await agent(3, { uri: 'https://example.com/a.json' });
    await agent(4, { uri: 'data:ZZZNAME is a great agent,{}' }); // text smuggled in the media type slot
    for (const name of EXPORT_NAMES) expect(await ex(name)).not.toContain('ZZZNAME');
    const rows = parse(await ex('agents')).slice(1);
    expect(rows.map((r) => r[3])).toEqual(['data:application/json', 'data:application/json', 'https://example.com/a.json', 'data:']);
  });

  it("a hidden agent's uri is blank", async () => {
    await agent(1, { uri: 'https://example.com/secret.json' });
    await agent(2, { uri: 'https://example.com/ok.json' });
    await sql`insert into discovery.hidden (agent_id) values (1)`;
    const rows = parse(await ex('agents')).slice(1);
    expect(rows[0]![3]).toBe('');
    expect(rows[1]![3]).toBe('https://example.com/ok.json');
  });

  it('a long uri is truncated to 512 chars', async () => {
    await agent(1, { uri: 'https://e.com/' + 'a'.repeat(2000) });
    expect(parse(await ex('agents'))[1]![3]!.length).toBe(512);
  });

  it('the row cap is reported as truncated, and only past the cap', async () => {
    for (let i = 1; i <= 3; i++) await agent(i);
    const at = (maxRows: number) => exportCsv(sql, 'agents', { now: () => NOW, maxRows });
    const cut = await at(2);
    expect(cut.truncated).toBe(true);
    expect(parse(cut.csv).length - 1).toBe(2);
    const full = await at(3);
    expect(full.truncated).toBe(false);
    expect(parse(full.csv).length - 1).toBe(3);
  });
});
