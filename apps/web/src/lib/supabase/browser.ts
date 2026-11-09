import { createBrowserClient } from '@supabase/ssr';
import { PUBLIC } from '@/lib/public-config';

/** The browser's Supabase client. The anon key is public by design; the session lives in cookies, not in web storage. */
export const supabaseBrowser = () => createBrowserClient(PUBLIC.supabaseUrl, PUBLIC.supabaseAnonKey, { isSingleton: true });
