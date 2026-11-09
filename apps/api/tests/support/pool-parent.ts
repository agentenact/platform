/** Test helper: a parent process that starts a pool child stuck in a main-thread spin, prints its pid, and waits to be killed. */
import { createPool } from '../../src/tools/isolate.js';

const pool = createPool({ size: 1, testKinds: true });
void pool.run('spin', {}, 60_000);
const end = Date.now() + 15_000;
while (pool.snapshot().busyPids.length === 0 && Date.now() < end) await Bun.sleep(10);
console.log(`PID ${pool.snapshot().busyPids[0]}`);
await Bun.sleep(60_000);
