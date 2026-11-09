import { Keypair } from '@stellar/stellar-sdk';
import type { Db } from '../../src/db/index.js';
import { parseSpec, type AgentSpec } from '../../src/specs/schema.js';
import { contractAddress, insertUser } from './fixtures.js';

/** A valid spec with defaults filled, as parseSpec returns it. */
export function minimalSpec(over: Partial<AgentSpec> = {}): AgentSpec {
  const r = parseSpec({ persona: 'A careful Stellar analyst.', system_prompt: 'Watch XLM and report clearly.', ...over });
  if (!r.ok) throw new Error(`minimalSpec: ${r.problem}`);
  return r.spec;
}

/** Distinct owner wallets per call: a random fill collided on the unique owner address (birthday, flaky). */
let ownerFill = 0;

/** A user with a wallet and an `active` agent holding a (fake, unfunded) runtime address. */
export async function activeAgent(sql: Db, over: { email?: string } = {}): Promise<{ userId: string; agentId: string; address: string }> {
  const userId = await insertUser(sql, { ownerAddress: contractAddress(++ownerFill), ...(over.email ? { email: over.email } : {}) });
  const address = Keypair.random().publicKey();
  const rows = (await sql`insert into app.agents (user_id, name, status, stellar_address, agent_id)
                          values (${userId}, 'test agent', 'active', ${address}, '77') returning id`) as { id: string }[];
  return { userId, agentId: rows[0]!.id, address };
}
