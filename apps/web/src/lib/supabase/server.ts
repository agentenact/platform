import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { PUBLIC } from '@/lib/public-config';

/** Supabase for server components, actions and route handlers; cookie writes are ignored where Next forbids them (proxy.ts refreshes). */
export async function supabaseServer() {
  const jar = await cookies();
  return createServerClient(PUBLIC.supabaseUrl, PUBLIC.supabaseAnonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll(list) {
        try {
          for (const c of list) jar.set(c.name, c.value, c.options);
        } catch {
          /* called from a server component: the proxy refreshes the session */
        }
      },
    },
  });
}
