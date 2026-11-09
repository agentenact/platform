/** Spec §6 per-mode budgets: platform constants (owner-tunable budgets are on the before-mainnet list). */
import type { RunMode } from '../runs/index.js';
import type { Budget } from './run.js';

export type ModeBudget = Budget & { maxUsdc: string };

export const BUDGETS: Record<RunMode, ModeBudget> = {
  chat: { maxTokens: 120_000, maxOutputTokens: 8_000, maxToolCalls: 30, maxSteps: 32, wallClockMs: 120_000, maxUsdc: '0.10' },
  mission: { maxTokens: 300_000, maxOutputTokens: 16_000, maxToolCalls: 60, maxSteps: 62, wallClockMs: 300_000, maxUsdc: '0.25' },
  // Gate 2: a paid service must finish in 30 s (our abort), well inside the library's 60 s handlerTimeoutMs.
  service: { maxTokens: 20_000, maxOutputTokens: 4_000, maxToolCalls: 2, maxSteps: 3, wallClockMs: 30_000, maxUsdc: '0' },
};
