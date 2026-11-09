import { test, expect } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { loop } from './loop';
import { loopingModel } from './helpers';
const ping = (f: (i: any, o: any) => any = async () => 'p') => tool({ description: 'p', inputSchema: z.object({}), execute: f });
const B = { maxTokens: 1e6, maxToolCalls: 100, maxSteps: 50, wallClockMs: 5000 };

test('done', async () => { const r = await loop({ model: loopingModel('ping', 1), tools: { ping: ping() }, prompt: 'x', budget: B }); expect(r.stop).toBe('done'); expect(r.usage.steps).toBe(2); });
test('token budget', async () => { const m = loopingModel('ping'); const r = await loop({ model: m, tools: { ping: ping() }, prompt: 'x', budget: { ...B, maxTokens: 3000 } }); expect(r.stop).toBe('tokens'); expect(m.doGenerateCalls.length).toBe(3); });
test('step cap', async () => { const r = await loop({ model: loopingModel('ping'), tools: { ping: ping() }, prompt: 'x', budget: { ...B, maxSteps: 4 } }); expect(r.stop).toBe('steps'); });
test('tool cap stops the run, metering intact', async () => { const m = loopingModel('ping'); const r = await loop({ model: m, tools: { ping: ping() }, prompt: 'x', budget: { ...B, maxToolCalls: 2 } }); expect(r.stop).toBe('tool_calls'); expect(m.doGenerateCalls.length).toBe(3); console.log('toolcap usage', r.usage); });
test('external abort mid-tool', async () => { const ac = new AbortController(); const m = loopingModel('ping'); let n = 0; const r = await loop({ model: m, tools: { ping: ping(async () => { if (++n === 2) ac.abort(); return 'p'; }) }, prompt: 'x', budget: B, signal: ac.signal }); expect(r.stop).toBe('aborted'); expect(m.doGenerateCalls.length).toBe(2); });
test('wall clock', async () => { const m = loopingModel('slow'); const r = await loop({ model: m, tools: { slow: ping((_i, o) => new Promise((res, rej) => { o.abortSignal?.addEventListener('abort', () => rej(o.abortSignal.reason)); setTimeout(res, 3000); })) }, prompt: 'x', budget: { ...B, wallClockMs: 120 } }); expect(r.stop).toBe('timeout'); });
test('pre-aborted: zero LLM calls', async () => { const m = loopingModel('ping'); const r = await loop({ model: m, tools: { ping: ping() }, prompt: 'x', budget: B, signal: AbortSignal.abort() }); expect(r.stop).toBe('aborted'); expect(m.doGenerateCalls.length).toBe(0); });
test('onUsage called per step', async () => { const seen: number[] = []; await loop({ model: loopingModel('ping', 2), tools: { ping: ping() }, prompt: 'x', budget: B, onUsage: (u) => { seen.push(u.steps); } }); expect(seen).toEqual([1, 2, 3]); });
