import { defineConfig } from '@playwright/test';

/**
 * Opt-in browser e2e against the deployed panel (the passkey's rpId and origin are fixed, so it cannot run on localhost).
 * Uses the installed Google Chrome, so nothing is downloaded. Run: bun run e2e (reads the service role key from servel).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.e2e.ts',
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.E2E_BASE_URL || 'https://agentenact.io', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
});
