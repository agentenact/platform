import { cache } from 'react';
import { supabaseServer } from '@/lib/supabase/server';
import type { HeaderMe } from '@/lib/header-me';
import { getMe, type GetMe } from './me';

export type { HeaderMe };
export type GetHeaderMe = () => Promise<HeaderMe | null>;

/** The signed-in visitor's email and agent name, or null when signed out. A failing api only drops the agent name. */
export function createGetHeaderMe(d: { email(): Promise<string | undefined>; me: GetMe }): GetHeaderMe {
  return async () => {
    try {
      const email = await d.email();
      if (!email) return null;
      const me = await d.me().catch(() => null);
      const name = me?.agent?.name;
      return name ? { email, agentName: name } : { email };
    } catch {
      return null;
    }
  };
}

export const getHeaderMe: GetHeaderMe = createGetHeaderMe({
  // Once per request: getUser is a network call to the auth server, and the proxy has just made one already.
  email: cache(async () => (await (await supabaseServer()).auth.getUser()).data.user?.email || undefined),
  me: getMe,
});
