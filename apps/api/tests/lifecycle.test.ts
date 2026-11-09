import { describe, expect, it } from 'bun:test';
import { createShutdown, CRITICAL_GRACE_MS, SHUTDOWN_GRACE_MS, SHUTDOWN_STEP_MS, trackStarts } from '../src/lifecycle.js';
import type { StartOutcome } from '../src/provision/index.js';

describe('graceful shutdown', () => {
  const harness = (graceMs: number) => {
    const order: string[] = [];
    let finish!: (o: StartOutcome) => void;
    const tracked = trackStarts({ start: () => new Promise<StartOutcome>((r) => (finish = r)) });
    const shutdown = createShutdown({
      stop: () => void order.push('stop'),
      inflight: tracked.inflight,
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (code) => void order.push(`exit ${code}`),
      graceMs,
    });
    return { order, tracked, shutdown, finish: (o: StartOutcome) => finish(o) };
  };

  it('best-effort work keeps its 7 s grace; money work gets CRITICAL_GRACE_MS (servel.yaml stop_grace_period covers it: replica.test.ts)', () => {
    expect(SHUTDOWN_GRACE_MS).toBe(7_000);
    expect(CRITICAL_GRACE_MS).toBe(120_000);
    expect(SHUTDOWN_STEP_MS).toBe(400);
  });

  it('stops the server, waits for in-flight starts, closes the app pool, THEN releases the lock, exits 0', async () => {
    const h = harness(5_000);
    void h.tracked.start('agent-1');
    expect(h.tracked.inflight()).toHaveLength(1);
    const done = h.shutdown();
    await Bun.sleep(20);
    expect(h.order).toEqual(['stop']); // still waiting for the start
    h.finish({ outcome: 'active' });
    await done;
    expect(h.order).toEqual(['stop', 'close db', 'release', 'exit 0']);
    expect(h.tracked.inflight()).toHaveLength(0);
  });

  it('gives up waiting after the grace period; a second signal does not run it twice', async () => {
    const h = harness(40);
    void h.tracked.start('agent-1');
    const t0 = Date.now();
    await Promise.all([h.shutdown(), h.shutdown()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(h.order).toEqual(['stop', 'close db', 'release', 'exit 0']);
  });

  it('stops the tool pool after the grace wait and before closing the db', async () => {
    const order: string[] = [];
    let finish!: (o: StartOutcome) => void;
    const tracked = trackStarts({ start: () => new Promise<StartOutcome>((r) => (finish = r)) });
    void tracked.start('agent-1');
    const done = createShutdown({
      stop: () => void order.push('stop'),
      inflight: tracked.inflight,
      stopTools: async () => void order.push('stop tools'),
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (code) => void order.push(`exit ${code}`),
      graceMs: 5_000,
    })();
    await Bun.sleep(20);
    expect(order).toEqual(['stop']); // tools keep running while starts are in flight
    finish({ outcome: 'active' });
    await done;
    expect(order).toEqual(['stop', 'stop tools', 'close db', 'release', 'exit 0']);
  });

  it('a failing pool close or release still exits', async () => {
    const order: string[] = [];
    await createShutdown({
      stop: () => undefined,
      inflight: () => [],
      closeDb: async () => { throw new Error('gone'); },
      release: async () => { order.push('release'); throw new Error('gone'); },
      exit: (c) => void order.push(`exit ${c}`),
      graceMs: 10,
    })();
    expect(order).toEqual(['release', 'exit 0']); // a failing pool close still releases the lock
  });

  it('a stop that never resolves cannot block: grace race, force stop, tools, db, release, exit all still run in order', async () => {
    const order: string[] = [];
    const t0 = Date.now();
    await createShutdown({
      stop: () => {
        order.push('stop');
        return new Promise<void>(() => undefined); // Bun's server.stop() waits for open streams
      },
      inflight: () => [new Promise<void>(() => undefined)], // a start that never settles
      forceStop: async () => void order.push('force stop'),
      stopTools: async () => void order.push('stop tools'),
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (c) => void order.push(`exit ${c}`),
      graceMs: 60,
    })();
    expect(order).toEqual(['stop', 'force stop', 'stop tools', 'close db', 'release', 'exit 0']);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('every step is bounded: hanging or throwing steps do not stop the later ones', async () => {
    const order: string[] = [];
    const hang = () => new Promise<void>(() => undefined);
    const t0 = Date.now();
    await createShutdown({
      stop: () => {
        throw new Error('sync boom');
      },
      inflight: () => {
        throw new Error('boom');
      },
      forceStop: hang,
      stopTools: hang,
      closeDb: hang,
      release: async () => void order.push('release'),
      exit: (c) => void order.push(`exit ${c}`),
      graceMs: 10,
      stepMs: 30,
    })();
    expect(order).toEqual(['release', 'exit 0']);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a real Bun.serve with an open stream: shutdown ends within the grace and the request signal aborts', async () => {
    let aborted!: () => void;
    const abortedP = new Promise<void>((r) => (aborted = r));
    let draining = false;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (draining) return new Response('draining', { status: 503 });
        req.signal.addEventListener('abort', () => aborted());
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(': hi\n\n'));
              // never closes by itself
            },
          }),
        );
      },
    });
    const res = await fetch(`http://localhost:${server.port}/`);
    await res.body!.getReader().read(); // the stream is open
    const order: string[] = [];
    const t0 = Date.now();
    await createShutdown({
      // Bun 1.3.11: server.stop() followed by server.stop(true) does NOT force-close (measured: waits for
      // the idle timeout), so the graceful stop only drains and the force stop is the one real stop.
      stop: () => void (draining = true),
      forceStop: () => server.stop(true),
      inflight: () => [],
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (c) => void order.push(`exit ${c}`),
      graceMs: 100,
    })();
    expect(order).toEqual(['close db', 'release', 'exit 0']);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await Promise.race([abortedP, Bun.sleep(1_000).then(() => Promise.reject(new Error('request signal never aborted')))]);
  });
});

describe('graceful shutdown: lame duck', () => {
  it('unready first, still serving for lameDuckMs, then stop and the rest in order', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      unready: () => void order.push('unready'),
      lameDuckMs: 50,
      sleep: async (ms) => void order.push(`serve ${ms}`),
      stop: () => void order.push('stop'),
      inflight: () => [],
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (code) => void order.push(`exit ${code}`),
    });
    await shutdown();
    expect(order).toEqual(['unready', 'serve 50', 'stop', 'close db', 'release', 'exit 0']);
  });

  it('a throwing unready never stops the drain; a second signal joins the first', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      unready: () => {
        throw new Error('boom');
      },
      stop: () => void order.push('stop'),
      inflight: () => [],
      closeDb: async () => void order.push('close db'),
      release: async () => void order.push('release'),
      exit: (code) => void order.push(`exit ${code}`),
    });
    await Promise.all([shutdown(), shutdown()]);
    expect(order).toEqual(['stop', 'close db', 'release', 'exit 0']);
  });
});
