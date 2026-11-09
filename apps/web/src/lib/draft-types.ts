/**
 * The draft as the panel sees it. Zod-free mirror of apps/api/src/builder/draft-schema.ts: the api validates everything again
 * (edit, trial, handoff, create), so these types only describe what the screen reads and the guards only keep a corrupt
 * sessionStorage entry or an odd answer from crashing the render.
 */
export type Segment = string | { param: string };
export type OptionValue = string | number | boolean;

export interface NumberParam {
  id: string;
  label: string;
  kind: 'number';
  value: number;
  min: number;
  max: number;
  unit?: string;
}
export interface ChoiceParam {
  id: string;
  label: string;
  kind: 'choice';
  options: { label: string; value: OptionValue }[];
  value: OptionValue;
}
export interface TextParam {
  id: string;
  label: string;
  kind: 'text';
  value: string;
}
/** A time of day (or of one weekday): the value is the schedule `M H * * D`; presets are the quick picks. */
export interface TimeParam {
  id: string;
  label: string;
  kind: 'time';
  presets: { label: string; value: string }[];
  value: string;
}
export type ParamSpec = NumberParam | ChoiceParam | TextParam | TimeParam;

export interface Binding {
  param: string;
  path: string;
  scale?: number;
}

export interface DraftSpec {
  persona: string;
  system_prompt: string;
  skills: { name: string; description: string; body: string }[];
  [key: string]: unknown;
}

export interface DraftData {
  name: string;
  sentence: Segment[];
  params: ParamSpec[];
  bindings: Binding[];
  spec: DraftSpec;
}

export interface WouldHave {
  kind: 'email' | 'webhook' | 'hire' | 'remember';
  summary: string;
}
const WOULD_HAVE_KINDS: readonly WouldHave['kind'][] = ['email', 'webhook', 'hire', 'remember'];
export interface TrialData {
  status: 'done' | 'budget' | 'error';
  /** `line` and `reading` come from the api's one extractor; both null when the tool gave nothing to say. */
  condition: { held: boolean | null; data: string; line?: string | null; reading?: Record<string, number | string> | null } | null;
  text: string;
  wouldHave: WouldHave[];
  /** What each step used, in order; the words for a step come from `stepWords`. */
  steps: { n: number; tools: string[] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The draft if it has the shape the screen reads, else null. */
export function asDraft(v: unknown): DraftData | null {
  if (!isObj(v) || typeof v.name !== 'string' || !Array.isArray(v.sentence) || !Array.isArray(v.params) || !Array.isArray(v.bindings)) return null;
  const spec = v.spec;
  if (!isObj(spec) || typeof spec.persona !== 'string' || typeof spec.system_prompt !== 'string' || !Array.isArray(spec.skills)) return null;
  if (!spec.skills.every((s) => isObj(s) && typeof s.name === 'string' && typeof s.body === 'string')) return null;
  const segmentsOk = v.sentence.every((s) => typeof s === 'string' || (isObj(s) && typeof s.param === 'string'));
  const paramsOk = v.params.every(
    (p) =>
      isObj(p) &&
      typeof p.id === 'string' &&
      typeof p.label === 'string' &&
      ((p.kind === 'number' && typeof p.value === 'number' && typeof p.min === 'number' && typeof p.max === 'number') ||
        (p.kind === 'choice' && Array.isArray(p.options) && p.options.every((o) => isObj(o) && typeof o.label === 'string')) ||
        (p.kind === 'text' && typeof p.value === 'string') ||
        (p.kind === 'time' && typeof p.value === 'string' && Array.isArray(p.presets) && p.presets.every((o) => isObj(o) && typeof o.label === 'string' && typeof o.value === 'string'))),
  );
  if (!segmentsOk || !paramsOk) return null;
  // Every named parameter must exist, or the sentence cannot be drawn.
  const ids = new Set((v.params as { id: string }[]).map((p) => p.id));
  if (!(v.sentence as Segment[]).every((s) => typeof s === 'string' || ids.has(s.param))) return null;
  return v as unknown as DraftData;
}

/** Only the numbers and short words of a reading; anything else in it is dropped. Null when nothing is left. */
function asReading(v: unknown): Record<string, number | string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, number | string> = {};
  for (const [k, x] of Object.entries(v)) if ((typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 80)) out[k] = x;
  return Object.keys(out).length > 0 ? out : null;
}

export function asTrial(v: unknown): TrialData | null {
  if (!isObj(v) || typeof v.text !== 'string' || !Array.isArray(v.wouldHave)) return null;
  const wouldHave = v.wouldHave.filter((w): w is WouldHave => isObj(w) && typeof w.kind === 'string' && WOULD_HAVE_KINDS.includes(w.kind as WouldHave['kind']) && typeof w.summary === 'string');
  const c = v.condition;
  const condition =
    isObj(c) && (typeof c.held === 'boolean' || c.held === null)
      ? { held: c.held as boolean | null, data: '', line: typeof c.line === 'string' ? c.line : null, reading: asReading(c.reading) }
      : null;
  const status = v.status === 'budget' || v.status === 'error' ? v.status : 'done';
  const steps: TrialData['steps'] = [];
  if (Array.isArray(v.steps))
    for (const s of v.steps) if (isObj(s) && typeof s.n === 'number' && Array.isArray(s.tools)) steps.push({ n: s.n, tools: s.tools.filter((t): t is string => typeof t === 'string') });
  return { status, condition, text: v.text, wouldHave, steps };
}

/** What a Builder server action answers (same shape as src/server/builder-actions.ts; this file stays importable from client code). */
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; kind: 'sign_in' | 'daily' | 'busy' | 'failed'; message: string };
