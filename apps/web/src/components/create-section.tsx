import type { ReactNode } from 'react';

/** One section of the /create code view: an anchor, a small eyebrow, a head and its body. */
export function CreateSection({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-52 border-t border-line pt-10 pb-14 lg:scroll-mt-24 first:border-t-0 first:pt-0">
      <p className="font-mono text-[11.5px] tracking-[0.12em] text-accent-ink uppercase">{eyebrow}</p>
      <h2 id={`${id}-h`} className="headline mt-3 text-[clamp(1.5rem,2.6vw,2rem)]">
        {title}
      </h2>
      <div className="mt-5 text-[15.5px] leading-[1.65] text-fg-2 [&_code]:font-mono [&_code]:text-[0.92em] [&_code]:text-fg">{children}</div>
    </section>
  );
}
