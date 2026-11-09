/**
 * Pages that must be prerendered (○ in `next build`): they read nothing from the request, so a visit or a prefetch is a
 * file, never a server render or an auth round trip. scripts/check-static-routes.ts fails the build if one turns dynamic.
 */
export const MUST_BE_STATIC = ['/', '/explore', '/market', '/verify', '/create'] as const;

/** Pages that read the session and must stay rendered per request. */
export const MUST_BE_DYNAMIC = ['/dashboard', '/dashboard/chat', '/dashboard/earnings', '/dashboard/edit', '/dashboard/pause', '/draft'] as const;

/** What is wrong with a build's prerendered route list, if anything. */
export function staticRouteProblems(prerendered: readonly string[]): string[] {
  const have = new Set(prerendered);
  return [
    ...MUST_BE_STATIC.filter((r) => !have.has(r)).map((r) => `${r} is not static`),
    ...MUST_BE_DYNAMIC.filter((r) => have.has(r)).map((r) => `${r} was prerendered but reads the session`),
  ];
}
