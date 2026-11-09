'use server';
import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { createSignOut } from '@/server/sign-out';

/** Sign out this device, then return to the first screen. */
export async function signOutAction(): Promise<void> {
  await createSignOut({ client: supabaseServer, redirect })();
}
