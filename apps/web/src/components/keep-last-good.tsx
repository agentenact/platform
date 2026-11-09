'use client';
import { useRef, type ReactNode } from 'react';
import { copy } from '@/copy';
import { nextShown } from '@/lib/keep-last-good';

/**
 * The live-refreshing page's keeper. Every 30 s the server re-renders the page; when that fails (a 502, a timeout) the server
 * sends `ok={false}` and no page. This keeps the last good render on screen, with its open run rows (they are state of the same
 * elements, which stay mounted), and adds one quiet line. Only a failure on the very first load shows `error`.
 */
export function KeepLastGood({ ok, error, children }: { ok: boolean; error: ReactNode; children?: ReactNode }) {
  const good = useRef<ReactNode>(null);
  const r = nextShown<ReactNode>(good.current, ok, children ?? null);
  good.current = r.good;
  if (r.shown === null) return <>{error}</>;
  return (
    <>
      {r.shown}
      {r.stale ? (
        <p role="status" data-refresh-note="" className="mt-4 text-center text-xs text-fg-3">
          {copy.agent.refreshFailed}
        </p>
      ) : null}
    </>
  );
}
