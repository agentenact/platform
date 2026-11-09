import { MyAgentsSkeleton } from '@/components/page-skeleton';

/**
 * Shown the moment a link to My agents is followed, while the server reads the session and the agents. It lives in this
 * group, not in app/dashboard, so a link to one agent never shows the list first: an agent's page has its own
 * ([id]/loading.tsx), and Next shows the first loading file on the way down.
 */
export default function Loading() {
  return <MyAgentsSkeleton />;
}
