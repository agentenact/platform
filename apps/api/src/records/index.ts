/**
 * `records`: every Enactment Record one of our agents signed, keyed by its settlement tx, so "proof" can link
 * to a public address (spec §6b). A record is public by design (hashes and public addresses only), and it
 * proves attribution and payment, never that an output was correct.
 * `save` stores only a record this agent signed for this very tx: the record is re-parsed with the library's
 * own validator (unknown keys dropped), its settlement ref must be the tx and its signer the agent's address.
 * The signature itself is not re-verified here: the library just signed it with the agent's key.
 */
import { parseRecord, type EnactmentRecord } from 'agentenact';
import type { Db } from '../db/index.js';

export interface Records {
  /** Idempotent on `txHash`. False when the record is refused (wrong tx, wrong signer, malformed, unknown agent, tx owned by another agent). */
  save(agentId: string, runId: string | null, txHash: string, record: EnactmentRecord): Promise<boolean>;
  /** The agent's own record for `txHash`, or null. Another agent's tx is null. */
  get(agentId: string, txHash: string): Promise<EnactmentRecord | null>;
}

const TX = /^[0-9a-f]{64}$/;

export function createRecords(sql: Db): Records {
  return {
    async save(agentId, runId, txHash, record) {
      if (!TX.test(txHash)) return false;
      let rec: EnactmentRecord;
      try {
        rec = parseRecord(record);
      } catch {
        return false;
      }
      if (rec.settlement.ref !== txHash) return false;
      const agent = (await sql`select stellar_address from app.agents where id = ${agentId}`) as { stellar_address: string | null }[];
      if (!agent[0]?.stellar_address || rec.agent.address !== agent[0].stellar_address) return false;
      const inserted = (await sql`insert into app.records (tx_hash, agent_id, run_id, record)
                                  values (${txHash}, ${agentId}, ${runId}, ${rec})
                                  on conflict (tx_hash) do nothing returning tx_hash`) as unknown[];
      if (inserted.length > 0) return true;
      // Already stored: fine for the same agent, refused for anyone else.
      const same = (await sql`select 1 from app.records where tx_hash = ${txHash} and agent_id = ${agentId}`) as unknown[];
      return same.length > 0;
    },

    async get(agentId, txHash) {
      if (!TX.test(txHash)) return null;
      const rows = (await sql`select record from app.records where tx_hash = ${txHash} and agent_id = ${agentId}`) as { record: unknown }[];
      if (!rows[0]) return null;
      try {
        return parseRecord(rows[0].record); // only the record's own fields ever leave
      } catch {
        return null;
      }
    },
  };
}
