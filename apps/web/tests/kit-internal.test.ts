import { expect, test } from 'bun:test';

// The approve path passes a pre-resolved signer to smart-account-kit's internal signAuthEntryInternal so the press reaches
// the passkey prompt with no network call (Safari needs the prompt inside the user's tap). The public signAuthEntry drops
// `signer` and looks it up over RPC. If an upgrade removes or renames the internal method, the wallet silently falls back
// to the slow path; this test makes that loud.
test('smart-account-kit still has signAuthEntryInternal (pinned 0.8.0)', async () => {
  const mod = (await import('smart-account-kit')) as Record<string, unknown>;
  const Kit = (mod.SmartAccountKit ?? mod.default) as { prototype?: Record<string, unknown> } | undefined;
  expect(typeof Kit?.prototype?.signAuthEntryInternal).toBe('function');
});
