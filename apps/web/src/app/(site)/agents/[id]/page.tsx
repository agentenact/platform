import type { Metadata } from 'next';
import { ProfileLoader } from '@/components/agent-profile';

/**
 * The public profile of one registry agent (it was the site's /agent?id=N). The page is a shell; the browser fetches the
 * profile from the public api. It stays rendered per request on purpose: caching every id anyone types would let the cache
 * grow without bound, and the render reads nothing but the id (no session), so it costs a few milliseconds. No
 * loading.tsx on purpose: React holds a skeleton on screen for at least 300 ms, far longer than this render takes.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ok = /^\d{1,10}$/.test(id);
  return {
    title: ok ? `Agent #${id} — AgentEnact` : 'Agent — AgentEnact',
    description: 'One agent in the stellar-8004 registry on Stellar testnet: who owns it, what it sells, and its paid history with proofs.',
    ...(ok ? { alternates: { canonical: `https://agentenact.io/agents/${id}` } } : {}),
  };
}

export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="px-5 pt-10 pb-4">
      <div className="mx-auto max-w-6xl min-w-0">
        <ProfileLoader raw={id} />
      </div>
    </main>
  );
}
