/**
 * The key that names one creation (POST /api/agents `key`). It lives in this tab's sessionStorage beside the description it
 * was made for: pressing Try again, or reloading mid-creation, asks with the same key and gets the same agent; a different
 * description gets a new key, so an old key never answers a new draft with an old agent. Storage failing only costs that
 * protection across reloads (the key still holds for this page).
 */
const SLOT = 'ae:creation-key';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function creationKey(input: unknown, store: Storage | null, make: () => string = () => crypto.randomUUID()): string {
  const of = JSON.stringify(input);
  try {
    const held = JSON.parse(store?.getItem(SLOT) ?? 'null') as { of?: unknown; key?: unknown } | null;
    if (held && held.of === of && typeof held.key === 'string' && UUID.test(held.key)) return held.key;
  } catch {
    // unreadable or blocked: a new key
  }
  const key = make();
  try {
    store?.setItem(SLOT, JSON.stringify({ of, key }));
  } catch {
    // blocked storage: the key holds for this page only
  }
  return key;
}

/** The agent exists: the key has done its job and must not answer a later draft. */
export function forgetCreationKey(store: Storage | null): void {
  try {
    store?.removeItem(SLOT);
  } catch {
    // nothing to do
  }
}

export function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
