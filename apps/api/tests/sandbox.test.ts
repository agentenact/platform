import { beforeAll, describe, expect, it } from 'bun:test';
import { _resetPoolForTests } from '../src/tools/isolate.js';

import { runSandboxed } from '../src/tools/sandbox.js';

beforeAll(() => _resetPoolForTests());

describe('sandbox (fresh QuickJS runtime per call, in a Worker)', () => {
  it('computes over its input and returns JSON', async () => {
    expect(await runSandboxed('return { double: input.a * 2, ok: input.a > 20 }', { a: 21 })).toEqual({ ok: true, value: { double: 42, ok: true } });
  });

  it('has no host functions', async () => {
    expect(await runSandboxed('return [typeof fetch, typeof require, typeof process, typeof Bun, typeof setTimeout, typeof __input]', null)).toEqual({
      ok: true,
      value: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'string'],
    });
  });

  it('keeps no state between calls', async () => {
    await runSandboxed('globalThis.leak = 1; return 1', null);
    expect(await runSandboxed('return typeof globalThis.leak', null)).toEqual({ ok: true, value: 'undefined' });
  });

  it('interrupts an endless loop at the 2 s deadline', async () => {
    const t = Date.now();
    expect(await runSandboxed('while (true) {}', null)).toEqual({ ok: false, error: 'interrupted', fault: 'code' });
    expect(Date.now() - t).toBeLessThan(3_000);
  }, 10_000);

  it('stops at the 32 MB memory limit', async () => {
    // Under heavy machine load the 3 s wall clock can end the run before the heap fills: both outcomes fail closed.
    const r = await runSandboxed('const a = []; for (;;) a.push(new Array(100000).fill(a.length));', null);
    expect(r).toMatchObject({ ok: false, fault: 'code' });
    expect(['out of memory', 'killed']).toContain((r as { error: string }).error);
  }, 10_000);

  it('reports a thrown error by message only', async () => {
    expect(await runSandboxed('throw new Error("nope")', null)).toEqual({ ok: false, error: 'nope', fault: 'code' });
    expect(await runSandboxed('return (', null)).toMatchObject({ ok: false, fault: 'code' });
  });

  it('code that throws a pool word ("busy") is still the code failing, never a platform fault', async () => {
    for (const word of ['busy', 'unavailable', 'killed', 'aborted', 'error']) {
      expect(await runSandboxed(`throw new Error("${word}")`, null)).toEqual({ ok: false, error: word, fault: 'code' });
    }
  });

  it('kills the worker from the host when the runtime does not stop in time', async () => {
    expect(await runSandboxed('while (true) {}', null, { hardKillMs: 300 })).toEqual({ ok: false, error: 'killed', fault: 'code' });
  });

  it('returns null for undefined and refuses a huge result', async () => {
    expect(await runSandboxed('const x = 1;', null)).toEqual({ ok: true, value: null });
    expect(await runSandboxed('return "x".repeat(70000)', null)).toEqual({ ok: false, error: 'output too large', fault: 'code' });
  });

  it('params arrive as deeply frozen data next to input; no params means no global', async () => {
    expect(await runSandboxed('return [params.limit, params.nested.x, Object.isFrozen(params), Object.isFrozen(params.nested)]', null, { params: { limit: 7, nested: { x: 1 } } as never })).toEqual({
      ok: true,
      value: [7, 1, true, true],
    });
    expect(await runSandboxed('"use strict"; params.limit = 9', null, { params: { limit: 7 } })).toMatchObject({ ok: false, fault: 'code' });
    expect(await runSandboxed('params.limit = 9; params.extra = 1; return [params.limit, "extra" in params]', null, { params: { limit: 7 } })).toEqual({ ok: true, value: [7, false] });
    expect(await runSandboxed('return typeof params', null)).toEqual({ ok: true, value: 'undefined' });
    expect(await runSandboxed('return typeof params', null, { params: {} })).toEqual({ ok: true, value: 'undefined' });
  });

  it('code that declares its own const params still runs (no params on the trigger)', async () => {
    expect(await runSandboxed('const params = input; return params.x', { x: 3 })).toEqual({ ok: true, value: 3 });
    expect(await runSandboxed('params = input.x; return 1', { x: 3 })).toMatchObject({ ok: true });
  });

  it('compute code with let params is unaffected', async () => {
    expect(await runSandboxed('let params = 2; params += 1; return params', null)).toEqual({ ok: true, value: 3 });
  });

  it('a trigger with params exposes them read-only', async () => {
    expect(await runSandboxed('return [params.a, Object.isFrozen(params), typeof params]', null, { params: { a: 1 } })).toEqual({ ok: true, value: [1, true, 'object'] });
    expect(await runSandboxed('params.a = 2; delete globalThis.params; return params.a', null, { params: { a: 1 } })).toEqual({ ok: true, value: 1 });
    expect(await runSandboxed('const params = 5; return params', null, { params: { a: 1 } })).toEqual({ ok: true, value: 5 });
  });

  it('params cross the boundary as JSON data, never as code', async () => {
    const evil = '"); globalThis.pwned = 1; ("';
    expect(await runSandboxed('return [params.s, typeof globalThis.pwned]', null, { params: { s: evil } })).toEqual({ ok: true, value: [evil, 'undefined'] });
    expect(await runSandboxed('return 1', null, { params: { f: () => 1 } as never })).toMatchObject({ ok: false, fault: 'platform' });
  });
});
