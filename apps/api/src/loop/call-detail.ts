/**
 * What one tool call was about, for its owner only (Kerem's call, 2026-11-04): the search and what it found, the page
 * read, the email the agent wrote, the note it kept. It sits beside the redacted steps in its own column
 * (`runs.call_details`), is read only through the owner's one-run route, and is wiped when the agent is deleted.
 * Never a page's text, never a key, never a webhook URL (it may carry a secret); every string is clipped. Never throws.
 */

export interface CallDetail {
  query?: string;
  results?: { title: string; url: string }[];
  url?: string;
  title?: string;
  subject?: string;
  body?: string;
  note?: string;
  code?: string;
  /** What went in, as short JSON (a price read's arguments, a hire's input). */
  input?: string;
}

/** Where a detail belongs: step `n` (from 1), call `i` (from 0). */
export interface StoredDetail {
  n: number;
  i: number;
  d: CallDetail;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cut to `max` code points, control characters (but newlines) out. */
function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (!t) return null;
  const pts = Array.from(t);
  return pts.length > max ? `${pts.slice(0, max - 1).join('')}…` : t;
}

/** An http(s) URL, without user info, at most 500 characters; null otherwise. */
function webUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.username = '';
    u.password = '';
    const s = u.toString();
    return s.length <= 500 ? s : null;
  } catch {
    return null;
  }
}

function json(v: unknown, max: number): string | null {
  try {
    return v === undefined ? null : clip(JSON.stringify(v), max);
  } catch {
    return null;
  }
}

const SECRETISH = /key|secret|token|password|seed|mnemonic|private/i;

/** The detail of one call that returned, or null when there is nothing worth showing. */
export function callDetail(tool: string, args: unknown, result: unknown): CallDetail | null {
  try {
    const a = isObj(args) ? args : {};
    const r = isObj(result) ? result : {};
    const d: CallDetail = {};
    if (tool === 'web_search') {
      const q = clip(a.query, 400);
      if (q) d.query = q;
      if (Array.isArray(r.results)) {
        const hits = r.results
          .slice(0, 10)
          .map((h) => (isObj(h) ? { title: clip(h.title, 200) ?? '', url: webUrl(h.url) } : null))
          .filter((h): h is { title: string; url: string } => h !== null && h.url !== null);
        if (hits.length) d.results = hits;
      }
    } else if (tool === 'web_read') {
      const u = webUrl(r.url) ?? webUrl(a.url);
      if (u) d.url = u;
      const t = clip(r.title, 200);
      if (t) d.title = t;
    } else if (tool === 'send_email') {
      const s = clip(a.subject, 120);
      if (s) d.subject = s;
      const b = clip(a.text, 4000);
      if (b) d.body = b;
    } else if (tool === 'send_webhook') {
      const b = clip(a.text, 2000);
      if (b) d.body = b;
    } else if (tool === 'remember') {
      const n = clip(a.value, 2000);
      if (n) d.note = n;
    } else if (tool === 'compute') {
      const c = clip(a.code, 2000);
      if (c) d.code = c;
    } else if (tool === 'hire_agent') {
      const u = webUrl(a.url);
      if (u) d.url = u;
      const i = json(a.input, 1000);
      if (i) d.input = i;
    } else if (tool !== 'load_skill') {
      const i = json(args, 300);
      if (i && i !== '{}' && !SECRETISH.test(i)) d.input = i;
    }
    return Object.keys(d).length ? d : null;
  } catch {
    return null;
  }
}

interface WithDetails {
  n: number;
  calls?: { tool: string; line: string | null; detail?: CallDetail }[];
}

/** The steps without their details (what `steps` stores), and the details on their own. */
export function splitDetails<S extends WithDetails>(steps: S[]): { steps: S[]; details: StoredDetail[] } {
  const details: StoredDetail[] = [];
  const out = steps.map((s) => {
    if (!s.calls?.some((c) => c.detail)) return s;
    return {
      ...s,
      calls: s.calls.map((c, i) => {
        if (!c.detail) return c;
        details.push({ n: s.n, i, d: c.detail });
        const { detail: _, ...rest } = c;
        return rest;
      }),
    };
  });
  return { steps: out, details };
}

/** The steps with their details put back (the owner's one-run read). */
export function joinDetails<S extends WithDetails>(steps: S[], details: unknown): S[] {
  if (!Array.isArray(details) || details.length === 0) return steps;
  return steps.map((s) => {
    const mine = details.filter((x): x is StoredDetail => isObj(x) && x.n === s.n && typeof x.i === 'number' && isObj(x.d));
    if (!mine.length || !s.calls) return s;
    return { ...s, calls: s.calls.map((c, i) => {
      const hit = mine.find((x) => x.i === i);
      return hit ? { ...c, detail: hit.d } : c;
    }) };
  });
}
