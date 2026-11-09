'use client';
import { useRouter } from 'next/navigation';
import { CreateFlow } from '@/components/create-flow';
import type { DraftData } from '@/lib/draft-types';

/**
 * The creation flow on /agent itself (an agent that is still being set up). Already on that page, so "ready" refreshes it
 * instead of pushing the same address; the server then renders the finished agent.
 */
export function AgentCreateFlow({ draft, resume }: { draft: DraftData; resume: string }) {
  const router = useRouter();
  return <CreateFlow draft={draft} resume={resume} navigate={() => router.refresh()} />;
}
