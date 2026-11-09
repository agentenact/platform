'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { startLiveRefresh } from '@/lib/live-refresh';

/**
 * Re-reads the page's server data every `seconds` while it is visible, so numbers and the feed move without a reload.
 * The router part mounts only in the browser (after the first effect), so a server or static render never needs the
 * app router.
 */
export function LiveRefresh({ seconds = 30 }: { seconds?: number }) {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  return inBrowser ? <Refresher seconds={seconds} /> : null;
}

function Refresher({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(
    () =>
      startLiveRefresh({
        intervalMs: seconds * 1000,
        refresh: () => router.refresh(),
        isVisible: () => document.visibilityState === 'visible',
        every: (ms, fn) => {
          const t = setInterval(fn, ms);
          return () => clearInterval(t);
        },
        onVisibilityChange: (fn) => {
          document.addEventListener('visibilitychange', fn);
          return () => document.removeEventListener('visibilitychange', fn);
        },
      }),
    [router, seconds],
  );
  return null;
}
