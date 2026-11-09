import { legacyTab } from '@/server/dashboard-route';

export const dynamic = 'force-dynamic';

/** The address from before several agents per account: it goes to that tab of the owner's agent (see legacyTab). */
export default async function LegacySkillsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return legacyTab('skills', await searchParams);
}
