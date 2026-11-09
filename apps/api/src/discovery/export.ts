import type { Db } from '../db/index.js';
import { predicates } from './predicates.js';
import { formatUsdc } from './queries.js';

export type ExportName = 'agents' | 'payments' | 'proven-sales' | 'activity';
export const EXPORT_NAMES: readonly ExportName[] = ['agents', 'payments', 'proven-sales', 'activity'];

export const MAX_ROWS = 100_000;
/** The uri column is chain data an agent controls: bound it. */
const MAX_URI = 512;

/** `data:` uris carry the agent's own text inline, so only the media type leaves; hidden agents export nothing. */
export function exportUri(uri: unknown, hidden: boolean): string {
  if (hidden || typeof uri !== 'string') return '';
  if (/^data:/i.test(uri)) {
    // The media type is agent-written too: keep it only when it is a plain type/subtype token.
    const type = /^data:([^;,]*)/i.exec(uri)![1]!;
    return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,40}$/i.test(type) ? `data:${type.toLowerCase()}` : 'data:';
  }
  return uri.slice(0, MAX_URI);
}

type Row = Record<string, unknown>;
type Cell = string | number | boolean | Date | null | undefined;

/** Spreadsheet formula injection: a cell that starts with one of these is read as a formula, so it gets a leading apostrophe. */
const FORMULA = /^[=+\-@\t\r]/;

function cell(v: Cell, alwaysQuote = false): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v instanceof Date ? v.toISOString() : v;
  if (FORMULA.test(s)) s = `'${s}`;
  return alwaysQuote || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header: string[], rows: Cell[][], quoted: ReadonlySet<number> = new Set()): string {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map((v, i) => cell(v, quoted.has(i))).join(','));
  return lines.join('\n') + '\n';
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

/**
 * CSV of the rows behind each total on the stats page. The predicates come from ./predicates.ts, the same ones stats() uses.
 * Only chain facts and verified-record fields: never self-published text (names, descriptions, services, feed labels).
 */
export async function exportCsv(
  sql: Db,
  name: ExportName,
  o: { includeExcluded?: boolean; now?: () => Date; maxRows?: number } = {},
): Promise<{ csv: string; truncated: boolean }> {
  const max = o.maxRows ?? MAX_ROWS;
  const lim = max + 1; // one extra row tells us the cap cut something
  let truncated = false;
  const cut = <T>(rows: T[]): T[] => {
    if (rows.length > max) { truncated = true; return rows.slice(0, max); }
    return rows;
  };
  const csv = await build(sql, name, o.includeExcluded === true, (o.now ?? (() => new Date()))().toISOString(), lim, cut);
  return { csv, truncated };
}

async function build(sql: Db, name: ExportName, all: boolean, nowIso: string, lim: number, cut: <T>(r: T[]) => T[]): Promise<string> {
  const p = predicates(sql);

  switch (name) {
    case 'agents': {
      const rows = cut((await sql`
        select a.agent_id, a.owner, a.wallet, a.uri, a.registered_at, a.registered_tx, a.source, ${p.builderOf(nowIso)} as builder,
          (h.agent_id is not null) as hidden
        from discovery.agents a
        left join discovery.selfpub sp on sp.agent_id = a.agent_id
        left join discovery.hidden h on h.agent_id = a.agent_id
        order by a.agent_id
        limit ${lim}
      `)) as Row[];
      return csv(
        ['agent_id', 'owner', 'wallet', 'uri', 'registered_at', 'registered_tx', 'source', 'builder'],
        rows.map((r) => [r.agent_id, r.owner, r.wallet, exportUri(r.uri, r.hidden === true), iso(r.registered_at), r.registered_tx, r.source, r.builder] as Cell[]),
        new Set([3]),
      );
    }
    case 'payments': {
      const rows = cut((await sql`
        select op_id, idx, tx_hash, agent_id, payer, payer_agent_id, amount_units::text as units, asset, at, counted, excluded_reason
        from discovery.payments
        where ${all ? sql`true` : p.countedPayment}
        order by at, op_id, idx
        limit ${lim}
      `)) as Row[];
      const header = ['op_id', 'idx', 'tx_hash', 'agent_id', 'payer', 'payer_agent_id', 'amount_usdc', 'asset', 'at'];
      if (all) header.push('counted', 'excluded_reason');
      return csv(
        header,
        rows.map((r) => {
          const base: Cell[] = [r.op_id, r.idx, r.tx_hash, r.agent_id, r.payer, r.payer_agent_id, formatUsdc(r.units as string), r.asset, iso(r.at)] as Cell[];
          return all ? [...base, r.counted, r.excluded_reason] as Cell[] : base;
        }),
      );
    }
    case 'proven-sales': {
      const rows = cut((await sql`
        select settlement_ref, agent_id, agent_address, digest, payer, amount_units::text as units, asset, settled_at, source
        from discovery.proven_sales
        order by settled_at, settlement_ref, agent_address
        limit ${lim}
      `)) as Row[];
      return csv(
        ['settlement_ref', 'agent_id', 'agent_address', 'digest', 'payer', 'amount_usdc', 'asset', 'settled_at', 'source'],
        rows.map((r) => [r.settlement_ref, r.agent_id, r.agent_address, r.digest, r.payer, formatUsdc(r.units as string), r.asset, iso(r.settled_at), r.source] as Cell[]),
      );
    }
    case 'activity': {
      const rows = cut((await sql`
        select agent_id, kind, ref, at
        from discovery.activity
        where ${p.activeWindow(nowIso)}
        order by at desc, agent_id, kind, ref
        limit ${lim}
      `)) as Row[];
      return csv(['agent_id', 'kind', 'ref', 'at'], rows.map((r) => [r.agent_id, r.kind, r.ref, iso(r.at)] as Cell[]));
    }
  }
}
