'use client';
import { useEffect, useState } from 'react';
import { clockLeft } from '@/lib/agent-format';

/**
 * Time left until `at`, ticking once a second in the browser. The server (and the first paint) shows `initial`, the plain
 * words it can say without a clock of its own; the ticking starts after mount, so nothing mismatches.
 */
export function Countdown({ at, initial, due }: { at: string; initial: string; due: string }) {
  const t = Date.parse(at);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  if (now === null || !Number.isFinite(t)) return <>{initial}</>;
  return <>{clockLeft(t - now) ?? due}</>;
}
