import { ConnectSkeleton } from '@/components/page-skeleton';

/** Shown the moment the account menu's link is followed, while the server reads the session and the keys. */
export default function Loading() {
  return <ConnectSkeleton />;
}
