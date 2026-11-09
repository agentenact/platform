'use client';

import { useEffect, useRef, useState } from 'react';

export interface NavGroup {
  title: string;
  items: { id: string; label: string }[];
}

/**
 * The /create code index: the grouped list from lg, a scrolling strip of links on smaller screens (`only` keeps one of
 * them, for a page that places them apart). The link of the section in view is marked with aria-current.
 */
export function CreateNav({ groups, only }: { groups: NavGroup[]; only?: 'strip' | 'list' }) {
  const ids = groups.flatMap((g) => g.items.map((i) => i.id));
  const [current, setCurrent] = useState(ids[0]);

  useEffect(() => {
    const sections = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -60% 0px' },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
    // ids come from static props; observing once on mount is intended
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The strip keeps the current section's link in sight as the page scrolls past it.
  const stripRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const link = strip?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!strip || !link || strip.offsetParent === null) return;
    strip.scrollTo({ left: link.offsetLeft - 16 });
  }, [current]);

  return (
    <nav aria-label="On this page" className={`min-w-0 ${only === 'strip' ? 'lg:hidden' : only === 'list' ? 'max-lg:hidden' : 'lg:sticky lg:top-24 lg:self-start'}`}>
      <ul ref={stripRef} className={`relative flex gap-1 overflow-x-auto pb-2 lg:hidden ${only === 'list' ? 'hidden' : ''}`}>
        {groups.flatMap((g) => g.items).map((i) => (
          <li key={i.id} className="shrink-0">
            <a
              href={`#${i.id}`}
              aria-current={current === i.id ? 'location' : undefined}
              className="block rounded-full border border-line px-3 py-2 text-[13px] text-fg-2 aria-[current=location]:border-[var(--wax-edge)] aria-[current=location]:text-fg"
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
      <div className={`hidden space-y-7 ${only === 'strip' ? '' : 'lg:block'}`}>
        {groups.map((g) => (
          <div key={g.title}>
            <p className="font-mono text-[11px] tracking-[0.12em] text-fg-3 uppercase">{g.title}</p>
            <ul className="mt-2.5 space-y-0.5 border-l border-line">
              {g.items.map((i) => (
                <li key={i.id}>
                  <a
                    href={`#${i.id}`}
                    aria-current={current === i.id ? 'location' : undefined}
                    className="-ml-px block border-l border-transparent py-1.5 pl-4 text-[14px] text-fg-2 transition-colors hover:text-fg aria-[current=location]:border-[var(--wax)] aria-[current=location]:text-fg"
                  >
                    {i.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
