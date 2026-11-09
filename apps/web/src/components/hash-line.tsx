'use client';

import { useEffect, useRef, useState } from 'react';

const HEX = '0123456789abcdef';
const TICKS = 12;
const TICK_MS = 45;

/**
 * A shortened hash (head…tail) whose changed characters scramble through random
 * hex before settling, so a one-character edit is visible as it happens.
 * Characters scrambling take the accent; once settled, characters that differ from `baseline` stay marked in danger red.
 */
export function HashLine({ value, baseline, head = 10, tail = 10 }: { value: string; baseline: string; head?: number; tail?: number }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const changed = [...value].map((c, i) => c !== from[i]);
    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      if (tick >= TICKS) {
        window.clearInterval(id);
        setShown(value);
        return;
      }
      setShown([...value].map((c, i) => (changed[i] ? HEX[Math.floor(Math.random() * 16)] : c)).join(''));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [value]);

  const cells = (start: number, end: number) =>
    [...shown.slice(start, end)].map((c, i) => {
      const at = start + i;
      const moving = shown[at] !== value[at];
      const forged = value[at] !== baseline[at];
      return (
        <span key={at} className={moving ? 'text-accent-ink' : forged ? 'text-danger' : undefined} style={forged && !moving ? { textDecoration: 'underline', textUnderlineOffset: '4px' } : undefined}>
          {c}
        </span>
      );
    });

  return (
    <span className="font-mono text-[13px] tabular-nums" aria-label={value}>
      {cells(0, head)}
      <span className="text-fg-3">…</span>
      {cells(shown.length - tail, shown.length)}
    </span>
  );
}
