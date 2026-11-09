import { describe, expect, it } from 'bun:test';
import { createLeaseLock } from '../src/chain/lock.js';

describe('createLeaseLock', () => {
  it('admits one holder at a time, in FIFO order', async () => {
    const lock = createLeaseLock(1_000);
    const order: string[] = [];
    const run = async (name: string) => {
      const release = await lock.acquire();
      order.push(`${name}+`);
      await Bun.sleep(5);
      order.push(`${name}-`);
      release();
    };
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    expect(lock.held).toBe(false);
  });

  it('release is idempotent: a double release never admits two holders', async () => {
    const lock = createLeaseLock(1_000);
    const r1 = await lock.acquire();
    const second = lock.acquire();
    const third = lock.acquire();
    r1();
    r1();
    const r2 = await second;
    let thirdIn = false;
    void third.then(() => (thirdIn = true));
    await Bun.sleep(10);
    expect(thirdIn).toBe(false);
    r2();
    (await third)();
  });

  it('the lease frees a holder that never releases', async () => {
    const lock = createLeaseLock(1_000);
    await lock.acquire(20); // abandoned
    const t0 = Date.now();
    const release = await lock.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    release();
  });
});

describe('createLeaseLock: acquire wait cap', () => {
  it('a waiter past the cap is refused with chain_busy, never holds, and lets later waiters through in order', async () => {
    const lock = createLeaseLock(1_000, 20);
    const r1 = await lock.acquire();
    const order: string[] = [];
    let lateHeld = false;
    const late = lock.acquire(undefined, () => order.push('late-released')).then((r) => ((lateHeld = true), r));
    await expect(late).rejects.toMatchObject({ code: 'chain_busy', message: 'chain: chain_busy' });
    const next = lock.acquire().then((r) => (order.push('next'), r));
    expect(lock.held).toBe(true); // r1 still holds
    r1();
    const r2 = await next;
    expect(lock.held).toBe(true);
    r2();
    expect([lateHeld, order, lock.held]).toEqual([false, ['next'], false]);
  });

  it('a waiter admitted before the cap keeps its turn', async () => {
    const lock = createLeaseLock(1_000, 1_000);
    const r1 = await lock.acquire();
    const second = lock.acquire();
    r1();
    (await second)();
    expect(lock.held).toBe(false);
  });
});
