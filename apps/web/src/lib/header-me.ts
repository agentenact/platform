import { useSyncExternalStore } from 'react';

/** What the header needs about the visitor. */
export interface HeaderMe {
  email: string;
  agentName?: string;
}

/** `undefined` = not known yet (a static page before its first check), `null` = signed out. */
export type HeaderMeState = HeaderMe | null | undefined;

export const HEADER_ME_PATH = '/api/header-me';

/** Only a well-formed answer counts; anything else reads as signed out, as a failing server read did before. */
export function parseHeaderMe(v: unknown): HeaderMe | null {
  if (typeof v !== 'object' || v === null) return null;
  const { email, agentName } = v as { email?: unknown; agentName?: unknown };
  if (typeof email !== 'string' || !email) return null;
  return typeof agentName === 'string' && agentName ? { email, agentName } : { email };
}

/**
 * The header's view of the session, shared by every island in the tab. Static pages start unknown and ask the server once
 * (`load`); a page the server rendered with the session (`/dashboard`, `/draft`) hands over what it knew (`set`), so later
 * static pages need not ask. Framework-free so it can be tested.
 */
export function createHeaderMeStore(d: { fetch: (path: string) => Promise<unknown>; now?: () => number }) {
  const now = d.now ?? Date.now;
  let state: HeaderMeState;
  let checkedAt = 0;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (v: HeaderMe | null) => {
    checkedAt = now();
    const same = state !== undefined && JSON.stringify(state) === JSON.stringify(v);
    state = v;
    if (!same) emit();
  };
  const load = (): Promise<void> => {
    inflight ??= d
      .fetch(HEADER_ME_PATH)
      .then((v) => set(parseHeaderMe(v)))
      .catch(() => set(null))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    get: (): HeaderMeState => state,
    set,
    /** Ask once; later calls are no-ops until `refreshAfterMs` has passed since the last answer. */
    ensure(refreshAfterMs = Infinity): Promise<void> {
      if (state !== undefined && now() - checkedAt < refreshAfterMs) return Promise.resolve();
      return load();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const headerMe = createHeaderMeStore({
  fetch: async (path) => {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
    return res.ok ? res.json() : null;
  },
});

/** The visitor as the header knows it; always `undefined` on the server, so a static render shows the signed-out header. */
export function useHeaderMe(): HeaderMeState {
  return useSyncExternalStore(headerMe.subscribe, headerMe.get, () => undefined);
}
