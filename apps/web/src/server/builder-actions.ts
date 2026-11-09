/** The logic behind the Builder server actions (app/actions/builder.ts), with its dependencies injected for tests. */
import { errorCopy } from '@/copy';
import { COMMUNITY_TEMPLATE_ID, TEMPLATE_ID } from '../lib/draft-state';
import { ADDRESS_PATTERNS, bannedWord } from '../lib/words';
import type { ApiCall } from './api';

export type ActionFailure = { ok: false; kind: 'sign_in' | 'daily' | 'busy' | 'failed'; message: string };
export type ActionResult<T> = ({ ok: true } & T) | ActionFailure;

export interface BuilderDeps {
  api: ApiCall;
  /** The signed-in visitor's access token, if any. */
  token(): Promise<string | undefined>;
  /** Where the matched word goes (default: one JSON line on stdout). Never receives user text. */
  log?(entry: { event: 'trial_words'; word: string }): void;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const fail = (kind: ActionFailure['kind'], message: string): ActionFailure => ({ ok: false, kind, message });

/** Maps an api answer to a result; `pick` reads the success body. Messages come from errorCopy, never from the api. */
function settle<T>(res: { status: number; json: unknown | null }, pick: (json: Record<string, unknown>) => T | null): ActionResult<T extends object ? T : never> {
  const body = obj(res.json);
  const code = str(body.error);
  if (res.status === 200) {
    const picked = pick(body);
    if (picked) return { ok: true, ...picked } as ActionResult<T extends object ? T : never>;
    return fail('failed', errorCopy(undefined, 502));
  }
  if (res.status === 429) {
    if (code === 'sign_in_to_keep_drafting') return fail('sign_in', errorCopy(code));
    if (code === 'daily_limit' || code === 'capacity_reached') return fail('daily', errorCopy(code));
    return fail('busy', errorCopy('rate_limited'));
  }
  if (res.status === 401) return fail('sign_in', errorCopy('sign_in_to_keep_drafting'));
  if (res.status === 409) return fail('busy', errorCopy(code, 409));
  return fail('failed', errorCopy(code, res.status, str(body.code)));
}

export function createBuilderActions(d: BuilderDeps) {
  const call = async <T>(path: string, body: unknown, pick: (json: Record<string, unknown>) => T | null) => {
    try {
      const token = await d.token();
      const res = await d.api(path, token ? { body, token } : { body, visitor: true });
      return settle(res, pick);
    } catch {
      // Includes panel_secret_missing: the anonymous call was not made. Nothing here carries the error object.
      return fail('failed', errorCopy(undefined, 503));
    }
  };
  const log = d.log ?? ((e) => console.info(JSON.stringify(e)));
  /**
   * The screen hides trial text that holds a technical word (see plainText). Say which word did it, so the Builder prompt can
   * be tuned: the word only, never the text. The api never sees what the panel hid, so the note belongs here.
   */
  const noteHiddenWords = (trial: unknown) => {
    try {
      const t = obj(trial);
      const lines = [str(t.text) ?? '', ...(Array.isArray(t.wouldHave) ? t.wouldHave.map((w) => str(obj(w).summary) ?? '') : [])];
      for (const line of lines) {
        const word = bannedWord(line);
        // An address is data, not a word: log only that one was hidden, never the address itself.
        if (word) log({ event: 'trial_words', word: ADDRESS_PATTERNS.some((re) => re.test(word)) ? 'address' : word.toLowerCase() });
      }
    } catch {
      /* logging must never break a trial */
    }
  };
  return {
    draft: (prompt: string, current?: unknown) =>
      call('/api/builder/draft', current === undefined || current === null ? { prompt } : { prompt, current }, (j) => (j.draft ? { draft: j.draft } : null)),
    edit: (draft: unknown, param: string, value: unknown) => call('/api/builder/edit', { draft, param, value }, (j) => (j.draft ? { draft: j.draft } : null)),
    trial: async (spec: unknown) => {
      const r = await call('/api/builder/trial', { spec }, (j) => (j.trial ? { trial: j.trial } : null));
      if (r.ok) noteHiddenWords(r.trial);
      return r;
    },
    /** Claims a parked draft once; needs a signed-in visitor (the api answers 401, which becomes `sign_in`). */
    claim: async (id: string) => {
      if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return fail('failed', errorCopy('not_found'));
      const token = await d.token().catch(() => undefined);
      if (!token) return fail('sign_in', errorCopy('sign_in_to_keep_drafting'));
      try {
        return settle(await d.api(`/api/builder/handoff/${id}/claim`, { method: 'POST', token }), (j) => (j.draft ? { draft: j.draft } : null));
      } catch {
        return fail('failed', errorCopy(undefined, 503));
      }
    },
    /** A ready draft (agent template) by id: no model call and no limit, so no token is sent either. */
    template: async (id: string) => {
      const community = COMMUNITY_TEMPLATE_ID.exec(id)?.[1];
      if (community) {
        // The api re-checks a community draft on every read (shape, draft checks, Builder scope); create re-checks it again.
        try {
          return settle(await d.api(`/public/templates/${community}`), (j) => (j.draft ? { draft: j.draft } : null));
        } catch {
          return fail('failed', errorCopy(undefined, 503));
        }
      }
      if (!TEMPLATE_ID.test(id)) return fail('failed', errorCopy('not_found'));
      try {
        return settle(await d.api('/api/builder/templates'), (j) => {
          const found = Array.isArray(j.templates) ? j.templates.map(obj).find((t) => t.id === id) : undefined;
          return found?.draft ? { draft: found.draft } : null;
        });
      } catch {
        return fail('failed', errorCopy(undefined, 503));
      }
    },
    /** The typed email binds the parked draft to that account; the api keeps only its hash. Never logged. */
    handoff: (draft: unknown, email?: string) => call('/api/builder/handoff', email ? { draft, email } : { draft }, (j) => (str(j.id) ? { id: str(j.id)! } : null)),
  };
}
