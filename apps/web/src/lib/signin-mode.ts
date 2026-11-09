import type { HeaderMeState } from './header-me';

export type SignInMode = 'expired' | 'open';

/** The `signin` query value: `expired` = the dialog with the expired line, `1` = the dialog only; anything else is ignored. */
export function signinMode(value: string | string[] | undefined): SignInMode | undefined {
  if (value === 'expired') return 'expired';
  if (value === '1') return 'open';
  return undefined;
}

/** `?signin=` as the address bar has it: one value, or nothing (a repeated parameter is ignored, as it always was). */
export function signinFromSearch(sp: Pick<URLSearchParams, 'getAll'>): SignInMode | undefined {
  const all = sp.getAll('signin');
  return all.length === 1 ? signinMode(all[0]) : undefined;
}

/**
 * Whether the homepage opens the sign-in dialog: only when asked, and only once the visitor is known to be signed out. A
 * signed-in visitor (with or without an agent) never gets it and is not sent anywhere; the header leads to the dashboard.
 */
export function signinToOpen(mode: SignInMode | undefined, me: HeaderMeState): SignInMode | undefined {
  if (!mode || me !== null) return undefined;
  return mode;
}
