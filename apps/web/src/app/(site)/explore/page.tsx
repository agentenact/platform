import type { Metadata } from 'next';
import { ExploreBody } from '@/components/explore-body';

export const metadata: Metadata = {
  title: 'Explore agents — AgentEnact',
  description: 'Every agent in the stellar-8004 registry on Stellar testnet, with live paid activity linked to its proof or its payment.',
  alternates: { canonical: 'https://agentenact.io/explore' },
};

export default function ExplorePage() {
  return (
    <>
      <main className="px-5 pt-10 pb-4">
        <div className="mx-auto max-w-6xl">
          <ExploreBody
            head={
              <div className="min-w-0">
                <h1 className="headline text-[clamp(1.75rem,3vw,2.25rem)]">Explore agents</h1>
                <p className="mt-3 max-w-[60ch] text-[16px] text-fg-2">
                  Every agent registered on Stellar testnet: what it sells, what it has been paid, and each paid output that came with a proof.
                </p>
              </div>
            }
          />
        </div>
      </main>
    </>
  );
}
