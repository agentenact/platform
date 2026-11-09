import { setDefaultTimeout } from 'bun:test';
import { testTimeoutMs, warmTemplate } from './db.js';

setDefaultTimeout(testTimeoutMs());
await warmTemplate();
