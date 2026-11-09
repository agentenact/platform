import { BRAND_HASH, Seal } from './seal';
import { AppLink } from '@/components/app-link';

/** The page closes on the split with AgentKarma and the package, then the one call to action. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line px-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 py-8 text-[13px] text-fg-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2.5">
          <Seal hash={BRAND_HASH} size={22} mark="var(--ground)" />
          <span>
            Enact proves who delivered and who paid. Reputation lives on{' '}
            <a href="https://agentkarma.io" className="underline decoration-line underline-offset-4 hover:text-fg">
              AgentKarma
            </a>
            .
          </span>
        </span>
        <p className="font-mono">
          <AppLink href="/create" className="hover:text-fg">
            create
          </AppLink>{' '}
          ·{' '}
          <a href="https://www.npmjs.com/package/agentenact" className="hover:text-fg">
            npm v0.2.0
          </a>{' '}
          · MIT
        </p>
      </div>
    </footer>
  );
}
