'use client';
import dynamic from 'next/dynamic';

/**
 * The sign-in dialog, loaded on demand. It pulls in the Supabase browser client and the Radix dialog (~70 KB gzipped),
 * which no page needs until someone asks to sign in, so it stays out of the header's bundle. `preloadSignIn` starts the
 * download early (hover, focus) so the dialog opens at once.
 */
const load = () => import('@/components/sign-in-dialog');

export const preloadSignIn = (): void => void load().catch(() => undefined);

export const LazySignInDialog = dynamic(() => load().then((m) => m.SignInDialog), { ssr: false });
