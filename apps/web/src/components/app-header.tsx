import { HeaderAccount, HeaderDashboardLink } from '@/components/header-account';
import { BRAND_HASH, Seal } from '@/components/seal';
import { copy } from '@/copy';
import type { HeaderMeState } from '@/lib/header-me';
import { AppLink } from '@/components/app-link';

const c = copy.shell;

const NAV = [
  { href: '/explore', label: c.explore },
  { href: '/market', label: c.market },
  { href: '/verify', label: c.verify },
  { href: '/create#install', label: c.developers },
  { href: 'https://agentkarma.io', label: c.karma },
];

const linkClass = 'rounded-full px-3 py-2.5 text-[14px] text-fg-2 transition-colors hover:text-fg';

/**
 * The one header of the app: the site's floating dark pill (.glass) with the seal mark, the testnet badge, the public
 * links and the call to action, then the visitor's account. Signed in with an agent: a Dashboard link to the owner's area.
 * Everything but the account is static. The account part is a small client island: a page rendered with the session passes
 * `me`; a static page leaves it out and the island asks once in the browser (components/header-account.tsx).
 */
export function AppHeader({ me }: { me?: HeaderMeState }) {
  return (
    <header className="site-header sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="glass mx-auto flex max-w-6xl items-center justify-between gap-2 rounded-full py-1.5 pr-1.5 pl-3 sm:pl-4">
        <AppLink href="/" className="flex min-h-11 min-w-0 shrink-0 items-center gap-2.5 font-display text-[15px] font-semibold tracking-[0.02em] text-fg uppercase">
          <Seal hash={BRAND_HASH} size={26} mark="var(--deep)" />
          <span className="max-[359px]:sr-only">{c.brand}</span>
          <span className="rounded-[4px] border border-[var(--caution)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--caution)] max-[359px]:hidden">{c.testnet}</span>
        </AppLink>
        <nav aria-label={c.nav} className="flex min-w-0 items-center gap-1">
          {NAV.map((item) => (
            <AppLink key={item.href} href={item.href} className={`hidden lg:inline ${linkClass}`}>
              {item.label}
            </AppLink>
          ))}
          <HeaderDashboardLink me={me} className={`hidden sm:inline ${linkClass}`} />
          <AppLink href="/create" className="btn btn-wax ml-1 h-11 px-4 text-[14px]">
            <span>
              {c.create}
              <span className="max-sm:hidden">{c.createTail}</span>
            </span>
          </AppLink>
          <HeaderAccount me={me} />
        </nav>
      </div>
    </header>
  );
}
