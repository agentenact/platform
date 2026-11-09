import { supabaseServer } from '@/lib/supabase/server';

/** The signed-in visitor's access token for the api, or undefined. The api verifies it; the panel only forwards it. */
export async function accessToken(): Promise<string | undefined> {
  const { data } = await (await supabaseServer()).auth.getSession();
  return data.session?.access_token || undefined;
}
