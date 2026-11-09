import { StrKey } from '@stellar/stellar-sdk';
import type { Db } from '../../src/db/index.js';

export const contractAddress = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill));

export async function insertUser(sql: Db, over: { id?: string; email?: string; ownerAddress?: string | null } = {}): Promise<string> {
  const id = over.id ?? crypto.randomUUID();
  await sql`insert into app.users (id, email, owner_address)
            values (${id}, ${over.email ?? `${id}@example.com`}, ${over.ownerAddress ?? null})`;
  return id;
}

export async function insertAgent(
  sql: Db,
  userId: string,
  over: { name?: string; status?: string; stellarAddress?: string | null } = {},
): Promise<string> {
  const rows = (await sql`insert into app.agents (user_id, name, status, stellar_address)
                          values (${userId}, ${over.name ?? 'test agent'}, ${over.status ?? 'provisioning'}, ${over.stellarAddress ?? null})
                          returning id`) as { id: string }[];
  return rows[0]!.id;
}
