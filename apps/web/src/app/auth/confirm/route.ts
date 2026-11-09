import { supabaseServer } from '@/lib/supabase/server';
import { createAuthConfirmRoute } from '@/server/auth-confirm';

// GET shows the Continue page and verifies nothing; POST (the button) verifies and signs in. See server/auth-confirm.ts.
const route = createAuthConfirmRoute(async () => {
  const supabase = await supabaseServer();
  return { verifyOtp: (a) => supabase.auth.verifyOtp(a) };
});

export const GET = route.GET;
export const POST = route.POST;
