import { Page } from '@/components/page';
import { SignInCard } from '@/components/sign-in';
import { SkillSetsManager } from '@/components/skill-sets';
import { copy } from '@/copy';
import { apiCall } from '@/server/api';
import { accessToken } from '@/server/session';
import { createSkillSetActions } from '@/server/skill-sets-actions';

export const dynamic = 'force-dynamic';

/** The owner's skill sets (api skills/sets.ts): a set keeps approved skills, each pinned, and is given to agents from their Skills tab. */
export default async function SkillSetsPage() {
  const signedIn = Boolean(await accessToken().catch(() => undefined));
  const listed = signedIn ? await createSkillSetActions({ api: apiCall, token: accessToken }).list() : null;
  return (
    <Page>
      {!signedIn ? (
        <section>
          <h1 className="headline text-2xl">{copy.skillSets.pageTitle}</h1>
          <div className="mt-4">
            <SignInCard next="/dashboard/skill-sets" />
          </div>
        </section>
      ) : listed?.ok ? (
        <SkillSetsManager sets={listed.data} />
      ) : (
        <p role="alert" className="text-lg">
          {listed?.message ?? copy.errors.generic}
        </p>
      )}
    </Page>
  );
}
