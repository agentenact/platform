import { CockpitSkeleton } from '@/components/page-skeleton';

/** Shown the moment a link to an agent is followed, while the server reads the agent: the cockpit's own layout. */
export default function Loading() {
  return <CockpitSkeleton />;
}
