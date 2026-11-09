import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { PUBLIC } from '../../src/lib/public-config';
import { bannedWord } from '../../src/lib/words';

// Real panel, real api, real Opus draft, real testnet agent. The three taps are answered by a CDP virtual authenticator.
// The service role key mints the sign-in link (a test cannot read mail); it stays in this process and is never printed.
const live = process.env.AGENTENACT_E2E === '1' && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASK = 'Tell me when XLM rises 5% in an hour';
const EMAIL = `kerem+e2e-${randomBytes(4).toString('hex')}@noras.tech`;

/**
 * Visible text outside the Technical details (`data-advanced`), the part the words table governs. Read from the live page:
 * a detached clone's innerText falls back to textContent and would include <script> data.
 */
const plainText = (page: Page) =>
  page.evaluate(() => {
    const advanced = [...document.querySelectorAll<HTMLElement>('[data-advanced]')];
    const before = advanced.map((n) => n.style.display);
    advanced.forEach((n) => (n.style.display = 'none'));
    const text = document.body.innerText;
    advanced.forEach((n, i) => (n.style.display = before[i]!));
    return text;
  });

async function withPasskeys(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Supabase admin generate_link: the same token a real email carries, for the same address. */
async function mintSignIn(email: string): Promise<string> {
  const res = await fetch(`${PUBLIC.supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}` },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!res.ok) throw new Error(`generate_link ${res.status}`);
  const body = (await res.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const token = body.properties?.hashed_token ?? body.hashed_token;
  if (!token) throw new Error('generate_link returned no hashed_token');
  return token;
}

/** Answers the creation steps (setup button, Approve presses) until the ready state, failing loudly on a dead end. */
async function finishCreation(tab: Page) {
  const deadline = Date.now() + 5 * 60_000;
  while (!(await tab.locator('[data-ready]').isVisible())) {
    if (Date.now() > deadline) throw new Error('creation did not finish in 5 minutes');
    const setup = tab.locator('[data-setup]');
    if (await setup.isVisible()) await setup.click();
    const approve = tab.locator('[data-answer="yes"]');
    if (await approve.isVisible()) await approve.click();
    const again = tab.getByRole('button', { name: 'Try again' });
    if (await again.isVisible()) throw new Error(`creation failed: ${await tab.locator('[data-create]').innerText()}`);
    await tab.waitForTimeout(1000);
  }
}

/**
 * The homepage ask hands over to /draft. Its input is controlled: a fill before hydration is wiped, and an empty prompt keeps
 * the homepage, so wait for the page to settle and for the value to hold before submitting.
 */
async function askOnHome(tab: Page) {
  await tab.waitForURL((u) => u.pathname === '/');
  await tab.waitForLoadState('networkidle');
  const input = tab.getByLabel(/Describe your agent/);
  await input.fill(ASK);
  await expect(input).toHaveValue(ASK);
  await tab.getByRole('button', { name: /^Create/ }).click();
  await tab.waitForURL((u) => u.pathname === '/draft');
}

/** The agent page: watching, the first check lands (the first-check card or the feed), plain words, pause and resume. */
async function agentPageWorks(tab: Page) {
  await tab.goto('/dashboard');
  await expect(tab.getByText('Watching')).toBeVisible({ timeout: 3 * 60_000 });
  await expect(tab.getByText(/First check ·|All quiet\. I am staying quiet\.|worth your time|Quiet since|checks?[,.]/).first()).toBeVisible({ timeout: 3 * 60_000 });
  expect(bannedWord(await plainText(tab))).toBeNull();
  await tab.getByRole('button', { name: 'Pause' }).click();
  await expect(tab.getByText('Paused')).toBeVisible();
  await tab.getByRole('button', { name: 'Resume' }).click();
  await expect(tab.getByText('Watching')).toBeVisible();
}

test.describe('create an agent in a browser with a passkey', () => {
  test.skip(!live, 'opt-in: AGENTENACT_E2E=1 and SUPABASE_SERVICE_ROLE_KEY');

  test('draft anonymously, sign in on a fresh browser, three taps, the agent watches, pause and resume', async ({ browser }) => {
    // 1. Anonymous: ask, draft, change a value, try it.
    const anon = await browser.newContext();
    const page = await anon.newPage();
    await page.goto('/');
    await askOnHome(page);
    const pill = page.locator('.value-pill').first();
    await expect(pill).toBeVisible({ timeout: 90_000 });
    await pill.click();
    await expect(page.locator('[data-editor]')).toBeVisible();
    await pill.click(); // a second tap closes the editor unchanged
    await expect(page.locator('[data-editor]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Try it first' }).click();
    // The anonymous trial allowance is one per IP per day, so a second run the same day ends in the limit notice; that is a
    // real, correct state, and the run still goes on to sign-in and creation, which are what this test is for.
    await expect(page.locator('[data-trial="done"], [data-trial="failed"], [data-trial="limit"]')).toBeVisible({ timeout: 120_000 });
    expect(bannedWord(await plainText(page))).toBeNull();

    // 2. Create: the email step parks the draft. Catch the link's `next` (it carries the parked draft id) and send no mail.
    let next = '';
    await page.route(`${PUBLIC.supabaseUrl}/auth/v1/otp**`, async (route) => {
      next = new URL(new URL(route.request().url()).searchParams.get('redirect_to') ?? 'https://x/').searchParams.get('next') ?? '';
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.getByRole('button', { name: /Create this agent/ }).click();
    await page.getByLabel('Your email').fill(EMAIL);
    await page.getByRole('button', { name: 'Send me a link' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    expect(next).toMatch(/^\/draft\?h=[A-Za-z0-9_-]{22}/);
    await anon.close();

    // 3. The link opens in a fresh browser: the draft is there, and the three taps are answered by the authenticator.
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await withPasskeys(ctx, tab);
    const token = await mintSignIn(EMAIL);
    await tab.goto(`/auth/confirm?${new URLSearchParams({ token_hash: token, type: 'email', next })}`);
    await tab.getByRole('button', { name: 'Continue' }).click(); // opening the link signs nobody in; the button does
    await expect(tab.locator('.value-pill').first()).toBeVisible({ timeout: 60_000 });
    const create = tab.getByRole('button', { name: /Create this agent/ });
    if (await create.isVisible()) await create.click();
    await expect(tab.getByText(/testnet/i).first()).toBeVisible();
    await finishCreation(tab);
    await agentPageWorks(tab);
    console.log(JSON.stringify({ email: EMAIL, agentPage: tab.url() }));
    await ctx.close();
  });
  // Independent of the anonymous per-IP quotas (3 drafts and 1 trial a day): sign in first, then draft as a signed-in owner.
  test('sign in first, draft signed in, three taps, the agent watches, pause and resume', async ({ browser }) => {
    const email = `kerem+e2e-${randomBytes(4).toString('hex')}@noras.tech`;
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await withPasskeys(ctx, tab);
    await tab.goto(`/auth/confirm?${new URLSearchParams({ token_hash: await mintSignIn(email), type: 'email', next: '/' })}`);
    await tab.getByRole('button', { name: 'Continue' }).click();
    await askOnHome(tab);
    await expect(tab.locator('.value-pill').first()).toBeVisible({ timeout: 120_000 });
    await tab.getByRole('button', { name: /Create this agent/ }).click();
    await finishCreation(tab);
    await agentPageWorks(tab);
    console.log(JSON.stringify({ email, agentPage: tab.url() }));
    await ctx.close();
  });
});
