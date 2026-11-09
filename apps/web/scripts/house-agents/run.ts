/**
 * Creates the house agents on production, one at a time; safe to run again, it continues where it stopped.
 * Run: scripts/house-agents/run.sh [--every <minutes>] [template-id ...]   (no ids: every template and extra)
 * --every waits that long after each agent it newly creates, so new ones open spread out; the process must stay running.
 *
 * Every agent has its own account (services.ts houseEmail) with a real passkey wallet. A virtual authenticator holds the
 * passkey, and its key is saved to KEY_DIR (0600, this machine only, one file per account), so the account can still approve
 * changes later. Losing a file loses the owner of that testnet agent, nothing else. Each creation key comes from the template id, so a repeat answers the same agent.
 * The browser profile is kept in PROFILE_DIR: the register approval a bind depends on lives only in that browser's storage,
 * so a run that stops between the two taps can finish in the next one. A fresh profile would have the bind refused for good.
 * An agent already past provisioning is left alone: no sign-in, so the stored approval of an unfinished one stays intact.
 */
import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HEADER_ME_PATH, parseHeaderMe } from '../../src/lib/header-me';
import { PUBLIC } from '../../src/lib/public-config';
import { BUYERS, houseAgents } from './services';

const SITE = 'https://agentenact.io';
const KEY_DIR = join(homedir(), '.config/agentenact');
/** The first account's key predates the split and keeps its file. */
const keyFile = (email: string) => join(KEY_DIR, email === 'kerem+house@noras.tech' ? 'house-passkey.json' : `house-passkey-${email}.json`);
const PROFILE_DIR = join(homedir(), '.config/agentenact/house-browser');
/** On the first account, stuck for good: their bind approvals were lost or refused. Their templates now get accounts of their own. */
const ABANDONED = ['e2e744f7-d32c-44ce-8f19-6962f5e15960', 'd9e4f653-7e0c-4cb3-953e-b10a3688fa04'];
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE) throw new Error('run this through run.sh: it reads the service role key from servel');

type Passkey = { cdp: CDPSession; authenticatorId: string };
const RETRY_EVERY_MS = 13 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Answers `request`, asking again for up to 10 minutes while the way to the service is down: no answer at all, or the
 * 502, 503 and 504 a proxy gives during a deploy. Each try calls `request` afresh, so a one-use link is minted anew.
 */
async function retrying(what: string, request: () => Promise<Response>): Promise<Response> {
  const deadline = Date.now() + 10 * 60_000;
  for (let wait = 5_000; ; wait = Math.min(wait * 2, 60_000)) {
    const res = await request().catch(() => null);
    if (res && ![502, 503, 504].includes(res.status)) return res;
    if (Date.now() > deadline) throw new Error(`${what}: ${res?.status ?? 'no answer'} for 10 minutes`);
    console.log(`  ${what}: ${res?.status ?? 'no answer'}, asking again in ${wait / 1000}s`);
    await sleep(wait);
  }
}

/** A deterministic uuid-shaped creation key: the same template always names the same agent. */
const keyOf = (templateId: string) => {
  const h = createHash('sha256').update(`agentenact-house:${templateId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function mint(email: string): Promise<string> {
  const res = await retrying('sign-in link', () =>
    fetch(`${PUBLIC.supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SERVICE_ROLE!, authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ type: 'magiclink', email }),
    }),
  );
  if (!res.ok) throw new Error(`generate_link ${res.status}`);
  const b = (await res.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const token = b.properties?.hashed_token ?? b.hashed_token;
  if (!token) throw new Error('generate_link returned no hashed_token');
  return token;
}

/** A session for the api, from a one-use link of its own, kept for 30 minutes so polling does not mint one per request. Never printed. */
const sessions = new Map<string, { token: string; until: number }>();
async function accessToken(email: string): Promise<string> {
  const session = sessions.get(email);
  if (session && Date.now() < session.until) return session.token;
  const res = await retrying('session', async () =>
    fetch(`${PUBLIC.supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: PUBLIC.supabaseAnonKey },
      // `email`, as the site's own sign-in link uses: an account's first link is a signup token, which `magiclink` refuses with 403.
      body: JSON.stringify({ type: 'email', token_hash: await mint(email) }),
    }),
  );
  if (!res.ok) throw new Error(`verify ${res.status}`);
  const token = ((await res.json()) as { access_token: string }).access_token;
  sessions.set(email, { token, until: Date.now() + 30 * 60_000 });
  return token;
}

async function api(email: string, path: string, init: { method?: string; body?: unknown; once?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const send = async () =>
    fetch(`${PUBLIC.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${await accessToken(email)}`, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const res = init.once ? await send() : await retrying(path, send);
  const text = await res.text();
  // A proxy in front of the api answers a hiccup in HTML: a status with no fields, which every caller reads as not ready yet.
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } catch {
    console.log(`  ${path}: ${res.status}, not json: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    return { status: res.status, json: {} };
  }
}

async function authenticator(page: Page, ctx: BrowserContext): Promise<Passkey> {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

/** Only this account's key is in the authenticator, so a prompt can never answer with another account's. */
async function loadPasskey(k: Passkey, email: string) {
  await k.cdp.send('WebAuthn.clearCredentials', { authenticatorId: k.authenticatorId });
  if (!existsSync(keyFile(email))) return;
  for (const credential of JSON.parse(readFileSync(keyFile(email), 'utf8'))) await k.cdp.send('WebAuthn.addCredential', { authenticatorId: k.authenticatorId, credential });
}

async function savePasskey(k: Passkey, email: string) {
  const { credentials } = await k.cdp.send('WebAuthn.getCredentials', { authenticatorId: k.authenticatorId });
  if (!credentials.length) return;
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(email), JSON.stringify(credentials), { mode: 0o600 });
  chmodSync(keyFile(email), 0o600);
}

/**
 * The account's wallet: made once, from the page (a passkey belongs to the site's origin), with the key saved first.
 * A challenge is good for one attempt, whatever the answer, and the api answers a failed deploy with its own 502 and frees
 * the claim. So a failed attempt starts over with a new challenge and a new key, within the api's 5 registers an hour.
 */
async function ensureWallet(page: Page, k: Passkey, email: string) {
  for (let attempt = 1; ; attempt++) {
    const me = await api(email, '/api/me');
    if (me.status !== 200) throw new Error(`/api/me ${me.status}`);
    if (me.json.ownerAddress) return;
    await k.cdp.send('WebAuthn.clearCredentials', { authenticatorId: k.authenticatorId });
    const opts = await api(email, '/api/passkey/options', { method: 'POST', body: {} });
    if (opts.status !== 200) throw new Error(`passkey options ${opts.status}`);
    const response = await page.evaluate(async (optionsJSON) => {
      const publicKey = (PublicKeyCredential as unknown as { parseCreationOptionsFromJSON(o: unknown): PublicKeyCredentialCreationOptions }).parseCreationOptionsFromJSON(optionsJSON);
      const c = (await navigator.credentials.create({ publicKey })) as unknown as { toJSON(): unknown };
      return c.toJSON();
    }, opts.json.optionsJSON);
    await savePasskey(k, email);
    const reg = await api(email, '/api/passkey/register', { method: 'POST', body: { response }, once: true }).catch((e: unknown) => ({ status: 0, json: { error: String(e) } as Record<string, unknown> }));
    if (reg.status === 200) return void console.log('  wallet ready');
    const why = `${reg.status} ${String(reg.json.error ?? '')}`;
    if (reg.status !== 0 && reg.status < 500) throw new Error(`passkey register ${why}`);
    if (attempt === 3) throw new Error(`passkey register ${why}, 3 tries`);
    console.log(`  passkey register ${why}, new try in 60s`);
    await sleep(60_000);
  }
}

/** Stays on the agent page, answering what it asks, until the agent is past provisioning. The page's own flow does the retries. */
async function approveUntilActive(page: Page, email: string, id: string): Promise<string> {
  await page.goto(`${SITE}/dashboard/${id}`);
  const deadline = Date.now() + 50 * 60_000;
  let said = '';
  let triedAt = 0;
  for (;;) {
    const a = await api(email, `/api/agents/${id}`);
    if (a.status === 200 && a.json.status !== 'provisioning') return a.json.status as string;
    const provision = a.json.provision as { step?: string; error?: string } | null | undefined;
    const failure = await page.locator('[data-failure]').first().getAttribute('data-failure', { timeout: 500 }).catch(() => null);
    const detail = failure ? await page.locator('[data-failure-detail]').first().textContent({ timeout: 500 }).catch(() => null) : null;
    const now = `${provision?.step ?? '?'} ${provision?.error ?? ''} ${failure ? `page: ${failure}` : ''} ${detail ?? ''}`.trim();
    if (now !== said) console.log(`  ${(said = now)}`);
    if (Date.now() > deadline) {
      const shot = join(KEY_DIR, `house-${id}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      throw new Error(`${id}: not ready in 50 minutes, last state: ${now}, screenshot: ${shot}`);
    }
    const approve = page.locator('[data-answer="yes"]');
    if (await approve.isVisible().catch(() => false)) await approve.click();
    // A failed birth retries only once its bind window has closed (minutes), and the api allows 5 retries an hour.
    const again = page.getByRole('button', { name: 'Try again' });
    if (Date.now() - triedAt > RETRY_EVERY_MS && (await again.isVisible().catch(() => false))) {
      triedAt = Date.now();
      // A reload, not the button: a page older than a web deploy can only answer "client: Error". A fresh one retries by itself.
      await page.reload();
    }
    await sleep(3000);
  }
}

/** The same key answers the same agent, so a lost answer is simply asked again (`retrying`). */
async function create(email: string, name: string, spec: unknown, key: string): Promise<string> {
  const r = await api(email, '/api/agents', { method: 'POST', body: { name, spec, key } });
  if (r.status === 200 || r.status === 202) return r.json.id as string;
  throw new Error(`create ${name}: ${r.status} ${String(r.json.error ?? '')} ${String(r.json.problem ?? '')}`);
}

/** What run.ts keeps in step with services.ts: the offer, and a buyer's tools, schedule and approved targets. */
const synced = (spec: Record<string, unknown> | undefined) => {
  const svc = (spec?.services as { skill_body?: string; tools?: string[] }[] | undefined)?.[0];
  const triggers = ((spec?.triggers as { cron?: string; mission?: string }[] | undefined) ?? []).map((t) => ({ cron: t.cron, mission: t.mission }));
  return JSON.stringify({ skill: svc?.skill_body, svcTools: svc?.tools, tools: spec?.tools ?? [], triggers, targets: spec?.hire_targets ?? [] });
};

/**
 * A changed description goes live as a new approved version; the same one writes nothing. `keepBuying`: the first pass does
 * not know the sellers' ids yet, so a buyer keeps the schedule and targets it has live (the second pass sets them).
 */
async function syncSpec(email: string, id: string, want: Record<string, unknown>, keepBuying = false): Promise<string> {
  const view = await api(email, `/api/agents/${id}/spec`);
  const live = (view.json.active as { spec?: Record<string, unknown> } | null)?.spec;
  if (!(live?.services as unknown[] | undefined)?.length) throw new Error(`${id}: no live offer to compare`);
  const spec = keepBuying ? { ...want, tools: live!.tools ?? [], triggers: live!.triggers ?? [], hire_targets: live!.hire_targets ?? [] } : want;
  if (synced(live) === synced(spec)) return '';
  const put = await api(email, `/api/agents/${id}/spec`, { method: 'PUT', body: { spec } });
  if (put.status !== 201) throw new Error(`${id}: save ${put.status} ${String(put.json.error ?? '')} ${String(put.json.problem ?? '')}`);
  const ok = await api(email, `/api/agents/${id}/spec/${String(put.json.version)}/approve`, { method: 'POST' });
  if (ok.status !== 204) throw new Error(`${id}: approve ${ok.status} ${String(ok.json.error ?? '')}`);
  return ` description updated to version ${String(put.json.version)}`;
}

/**
 * Signs the page in as exactly this account, or throws. A failed link leaves the old session in place, and the page then
 * answers another account's agent as "not yours", so the cookies go first and the answer is checked. localStorage stays:
 * it holds the approval of an unfinished agent.
 */
async function signIn(page: Page, email: string) {
  for (let attempt = 1; ; attempt++) {
    await page.context().clearCookies();
    await page.goto(`${SITE}/auth/confirm?${new URLSearchParams({ token_hash: await mint(email), type: 'email', next: '/' })}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/auth')).catch(() => undefined);
    const me = await page.request.get(`${SITE}${HEADER_ME_PATH}`).then((r) => r.json()).catch(() => null);
    if (parseHeaderMe(me)?.email.toLowerCase() === email) return;
    if (attempt === 3) throw new Error(`could not sign in as ${email}`);
    console.log(`  sign-in did not take, trying again (${attempt})`);
    await sleep(10_000);
  }
}

const args = process.argv.slice(2);
const everyAt = args.indexOf('--every');
const everyMin = everyAt >= 0 ? Number(args[everyAt + 1]) : 0;
if (everyAt >= 0 && !(everyMin > 0)) throw new Error('--every takes minutes');
const only = everyAt >= 0 ? args.filter((_, i) => i !== everyAt && i !== everyAt + 1) : args;
const list = houseAgents().filter((a) => !only.length || only.includes(a.templateId));
if (only.length && list.length !== only.length) throw new Error('unknown template id');

mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: true });
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const passkey = await authenticator(page, ctx);
  for (const id of ABANDONED) {
    const r = await api('kerem+house@noras.tech', `/api/agents/${id}`, { method: 'DELETE' });
    if (r.status !== 202) throw new Error(`could not remove ${id}: ${r.status} ${String(r.json.error ?? '')}`);
  }
  /** template id -> agent uuid, filled as the loop meets each agent: the buyers' second pass names its sellers by it. */
  const ids: Record<string, string> = {};
  for (const a of list) {
    console.log(`${a.templateId} (${a.email})`);
    const me = await api(a.email, '/api/me');
    if (me.status !== 200) throw new Error(`/api/me ${me.status}`);
    const made = me.json.ownerAddress ? await create(a.email, a.name, a.spec, keyOf(a.templateId)) : null;
    const before = made ? await api(a.email, `/api/agents/${made}`) : null;
    if (before?.status === 200 && before.json.status !== 'provisioning') {
      ids[a.templateId] = made!;
      console.log(`  ${made} ${String(before.json.status)}${await syncSpec(a.email, made!, a.spec, !!BUYERS[a.templateId])}`);
      continue;
    }
    await loadPasskey(passkey, a.email);
    await signIn(page, a.email);
    await ensureWallet(page, passkey, a.email);
    const id = made ?? (await create(a.email, a.name, a.spec, keyOf(a.templateId)));
    const status = await approveUntilActive(page, a.email, id);
    await savePasskey(passkey, a.email);
    ids[a.templateId] = id;
    console.log(`  ${id} ${status}`);
    if (everyMin && a !== list[list.length - 1]) {
      console.log(`  next one in ${everyMin} minutes`);
      await sleep(everyMin * 60_000);
    }
  }
  // Second pass: buyers whose sellers all exist now get their schedule and approved targets (services.ts BUYERS).
  for (const a of houseAgents(ids, PUBLIC.apiUrl).filter((x) => BUYERS[x.templateId] && ids[x.templateId] && x.spec.hire_targets)) {
    console.log(`${a.templateId} buys${await syncSpec(a.email, ids[a.templateId]!, a.spec)}`);
  }
} finally {
  await ctx.close();
}
