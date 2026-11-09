/**
 * Watchdog thread of an isolate child (see isolate-child.ts). Polls the parent pid once a second and
 * SIGKILLs the whole process when the parent is gone, even while the child's main thread is stuck in WASM.
 */
import { workerData } from 'node:worker_threads';

const parent = (workerData as { ppid: number }).ppid;
setInterval(() => {
  let gone = process.ppid !== parent;
  if (!gone) {
    try {
      process.kill(parent, 0);
    } catch {
      gone = true;
    }
  }
  if (gone) process.kill(process.pid, 'SIGKILL');
}, 1_000);
