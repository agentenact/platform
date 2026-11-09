import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how-it-works';
import { LiveProof } from '@/components/live-proof';
import { McpHarnesses } from '@/components/mcp-harnesses';
import { NetworkAgents } from '@/components/network-agents';
import { ReadyAgents } from '@/components/ready-agents';
import { HomeSignIn } from '@/components/home-sign-in';
import type { CapturedProof } from '@/lib/proof-types';

export { signinMode, type SignInMode } from '@/lib/signin-mode';

/**
 * The homepage, public for everyone (it was the site's): the night-sky hero with the ask, the numbers, the network's
 * agents, the ready agents, how it works, the MCP server and the live proof. The ask opens /draft in this app. It reads nothing from the
 * request, so it renders statically; `?signin=` (the header's Sign in link without script, an expired magic link) is read
 * in the browser, which opens the sign-in dialog over it for a visitor who is not signed in (components/home-sign-in.tsx).
 */
export function HomeView({ proof, verifierSrc }: { proof: CapturedProof; verifierSrc: string }) {
  return (
    <main className="pb-28">
      <HomeSignIn />
      <Hero recordHash={proof.record.output.sha256} />
      <NetworkAgents />
      <ReadyAgents />
      <HowItWorks />
      <McpHarnesses />
      <LiveProof proof={proof} verifierSrc={verifierSrc} />
    </main>
  );
}
