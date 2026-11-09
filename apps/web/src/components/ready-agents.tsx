import { builderUrl } from '@/lib/panel-url';
import { TEMPLATES } from '@/lib/templates';
import { AppLink } from '@/components/app-link';
import { TemplateIcon } from './template-icon';

/** The four the homepage shows, one of each kind; /create lists them all. */
export const FEATURED = ['xlm-drop', 'coin-crash', 'wallet-watch', 'daily-digest'];

/** Ready agents: each card opens it in the /create builder, where its values are set before trying it. No sign-up. */
export function ReadyAgents() {
  return (
    <section id="templates" className="px-5">
      <div className="mx-auto max-w-6xl pt-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">Start from a ready agent</h2>
          <p className="max-w-md text-[15px] leading-[1.55] text-fg-2">
            Pick one, change any value and try it on real data, then create it with your email and your device&rsquo;s screen lock: a PIN or password works,
            Face ID is optional.
          </p>
        </div>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATES.filter((t) => FEATURED.includes(t.id)).map((t) => (
            <li key={t.id} className="min-w-0">
              <AppLink href={builderUrl({ template: t.id })} className="card group flex h-full flex-col gap-4 p-5 transition-colors hover:border-[var(--edge-strong)]">
                <span className="grid size-11 place-items-center rounded-[12px] bg-[var(--wax-tint)] text-accent-ink">
                  <TemplateIcon id={t.id} />
                </span>
                <span className="text-[17px] font-semibold">{t.title}</span>
                <span className="text-[14px] leading-[1.5] text-fg-2">{t.summary}</span>
                <span className="mt-auto pt-2 text-[13px] font-medium text-accent-ink">
                  Set it up <span aria-hidden className="inline-block transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </AppLink>
            </li>
          ))}
        </ul>
        <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-fg-3">
          <AppLink href="/create" className="text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
            All {TEMPLATES.length} ready agents
          </AppLink>
          <AppLink href={builderUrl({ view: 'code' })} className="text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
            Build it yourself: library templates, setup and code
          </AppLink>
        </p>
      </div>
    </section>
  );
}
