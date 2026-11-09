/**
 * One isolate child process (spec §7). Reads one JSON job per line on stdin, answers one JSON line on
 * stdout, and exits when stdin closes. It holds no secrets (the parent passes a minimal env) and runs the
 * work that must never block or crash the api: QuickJS user code and Readability over hostile HTML.
 * Jobs run one at a time; a job that overruns is SIGKILLed by the parent.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { newQuickJSWASMModule, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
const SANDBOX_DEADLINE_MS = 2_000;
const MAX_OUTPUT_CHARS = 64 * 1024;
const EXTRACT_MAX_CHARS = 100_000;
const TITLE_MAX_CHARS = 300;
/** Job kinds that exist only for tests (env dump, main-thread spin): enabled by an argv flag only the test pool passes. */
const TEST_KINDS = process.argv.includes('--test-kinds');
/** RSS above this after a job: the reply carries `retire` and this child exits (the parent starts a fresh one). */
const RSS_RETIRE_BYTES = Number(process.argv.find((a) => a.startsWith('--rss-retire-bytes='))?.split('=')[1]) || 250 * 1024 * 1024;

// Watchdog: a Worker has its own thread, so it keeps running while this one is stuck inside WASM. If the
// parent dies (ppid changes) it SIGKILLs the whole process; stdin EOF alone cannot wake a stuck main thread.
const watchdog = new Worker(new URL('./isolate-watchdog.ts', import.meta.url).href, { workerData: { ppid: process.ppid } } as WorkerOptions);
(watchdog as unknown as { unref(): void }).unref();

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

const out = (id: number, r: Reply, retire: boolean | 'rss' = false) => process.stdout.write(`${JSON.stringify({ id, ...r, ...(retire ? { retire } : {}) })}\n`);

const mod = await newQuickJSWASMModule();
let tainted = false; // a failed dispose may leave the WASM heap unusable: answer, then exit

function runJs(code: string, inputJson: string, paramsJson: string | undefined): Reply {
  const rt = mod.newRuntime();
  rt.setMemoryLimit(SANDBOX_MEMORY_BYTES);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SANDBOX_DEADLINE_MS));
  const ctx = rt.newContext();
  let reply: Reply;
  try {
    // The code travels as a string global and is compiled by the runtime itself: it is never spliced into source text.
    const c = ctx.newString(code);
    ctx.setProp(ctx.global, '__code', c);
    c.dispose();
    const i = ctx.newString(inputJson);
    ctx.setProp(ctx.global, '__input', i);
    i.dispose();
    // `params` exists only when the trigger has some: a frozen read-only global (the code can read it, not change it).
    // Without params nothing new is in scope, so old code (`const params`, `params = x`) behaves exactly as before.
    let defineParams = '';
    if (paramsJson !== undefined) {
      const p = ctx.newString(paramsJson);
      ctx.setProp(ctx.global, '__params', p);
      p.dispose();
      defineParams = 'Object.defineProperty(globalThis, "params", { value: __freeze(JSON.parse(__params)), writable: false, enumerable: false, configurable: false });';
    }
    const r = ctx.evalCode(
      '"use strict"; const __freeze = (o) => { if (o !== null && typeof o === "object") { for (const k of Object.keys(o)) __freeze(o[k]); Object.freeze(o); } return o; };' +
        defineParams +
        'JSON.stringify(new Function("input", __code)(JSON.parse(__input)))',
    );
    if (r.error) {
      const err = ctx.dump(r.error) as unknown;
      r.error.dispose();
      const message = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err);
      reply = { ok: false, error: message.slice(0, 200) };
    } else {
      const dumped = ctx.dump(r.value) as unknown;
      r.value.dispose();
      if (dumped === undefined) reply = { ok: true, value: null };
      else if (typeof dumped !== 'string') reply = { ok: false, error: 'bad output' };
      else if (dumped.length > MAX_OUTPUT_CHARS) reply = { ok: false, error: 'output too large' };
      else reply = { ok: true, value: JSON.parse(dumped) };
    }
  } catch {
    reply = { ok: false, error: 'sandbox failed' };
  }
  try {
    ctx.dispose();
    rt.dispose();
  } catch {
    tainted = true; // e.g. the abort after a stack overflow; the real error is already in `reply`
  }
  return reply;
}

function extract(html: string): Reply {
  const { document } = parseHTML(html);
  document.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.textContent ?? document.body?.textContent ?? '';
  // eslint-disable-next-line no-control-regex
  const title = String(article?.title ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
  return { ok: true, value: { title, text: text.replace(/\s+/g, ' ').trim().slice(0, EXTRACT_MAX_CHARS) } };
}

function handle(line: string): void {
  let job: { id: number; kind: string; code?: string; input?: string; params?: string; html?: string };
  try {
    job = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  let reply: Reply;
  try {
    if (job.kind === 'js') reply = runJs(String(job.code), String(job.input), typeof job.params === 'string' ? job.params : undefined);
    else if (job.kind === 'extract') reply = extract(String(job.html));
    else if (TEST_KINDS && job.kind === 'env') reply = { ok: true, value: Object.keys(process.env) };
    else if (TEST_KINDS && job.kind === 'spin') for (;;);
    else reply = { ok: false, error: 'error' };
  } catch {
    reply = { ok: false, error: 'error' };
  }
  const retire = tainted ? true : process.memoryUsage().rss > RSS_RETIRE_BYTES ? ('rss' as const) : false;
  out(job.id, reply, retire); // `retire` tells the parent this child exits now
  if (retire) process.exit(0);
}

process.stdout.write('{"ready":true}\n');
const decoder = new TextDecoder();
let buf = '';
const reader = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value: chunk } = await reader.read();
  if (done) break;
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
}
process.exit(0);
