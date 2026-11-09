import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseVerifier } from '../../src/account/auth.js';

// Opt-in, against the deployed instance. Kerem exports the three values in his own shell:
//   AGENTENACT_SUPABASE=1 SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… bun test tests/e2e/supabase-auth.live.test.ts
// No email is sent: createUser and generateLink do not mail.
const live = process.env.AGENTENACT_SUPABASE === '1';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe.skipIf(!live)('Supabase Auth on the deployed instance', () => {
  let url = '';
  let anon = '';
  let service = '';
  let userId: string | undefined;

  beforeAll(() => {
    url = process.env.SUPABASE_URL ?? '';
    anon = process.env.SUPABASE_ANON_KEY ?? '';
    service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!url || !anon || !service) throw new Error('set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
  });

  afterAll(async () => {
    if (userId) await createClient(url, service, opts).auth.admin.deleteUser(userId);
  });

  it('a magic-link session verifies to its user; garbage does not', async () => {
    const admin = createClient(url, service, opts);
    const email = `p2-live-${crypto.randomUUID()}@agentenact.io`;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    userId = created.data.user.id;
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error) throw new Error(`generateLink: ${link.error.message}`);
    const signedIn = await createClient(url, anon, opts).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
    if (signedIn.error || !signedIn.data.session) throw new Error(`verifyOtp: ${signedIn.error?.message ?? 'no session'}`);

    const verify = createSupabaseVerifier({ url, anonKey: anon });
    expect(await verify(signedIn.data.session.access_token)).toEqual({ id: userId, email });
    expect(await verify('not-a-jwt')).toBeNull();
  }, 30_000);
});
