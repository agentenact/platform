import type { Db } from '../db/index.js';
import type { SerializedCredential } from '../owner-client/credential.js';
import type { AuthUser } from './auth.js';

/** Our profile of a Supabase user (app.users, keyed by auth.users.id). */
export interface Profile {
  id: string;
  email: string;
  ownerAddress: string | null;
  credentialId: string | null;
  credential: SerializedCredential | null;
}

interface Row {
  id: string;
  email: string;
  owner_address: string | null;
  passkey_credential_id: string | null;
  passkey_credential: SerializedCredential | null;
}

const toProfile = (r: Row): Profile => ({
  id: r.id,
  email: r.email,
  ownerAddress: r.owner_address,
  credentialId: r.passkey_credential_id,
  credential: r.passkey_credential,
});

export async function ensureProfile(sql: Db, u: AuthUser): Promise<Profile> {
  const rows = (await sql`insert into app.users (id, email) values (${u.id}, ${u.email})
                          on conflict (id) do update set email = excluded.email
                          returning id, email, owner_address, passkey_credential_id, passkey_credential`) as Row[];
  return toProfile(rows[0]!);
}

export async function getProfile(sql: Db, id: string): Promise<Profile | null> {
  const rows = (await sql`select id, email, owner_address, passkey_credential_id, passkey_credential
                          from app.users where id = ${id}`) as Row[];
  return rows[0] ? toProfile(rows[0]) : null;
}
