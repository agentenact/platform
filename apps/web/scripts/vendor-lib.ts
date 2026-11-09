/** Shared by the sync script and the drift tests, so both apply the same transform. */
export const HEADER = '// GENERATED, do not edit; source apps/api/src/owner-client';
export const CLIENT_IP_HEADER = '// GENERATED, do not edit; source apps/api/src/gateway/client-ip.ts';

/**
 * The api is NodeNext ESM and writes relative imports with `.js` (`./approve.js`). Next's Turbopack does not map `.js` to
 * `.ts` (verified on next 16.3.5: "Module not found: Can't resolve './testnet.js'"), so the vendored copy drops the
 * extension from relative specifiers. That is the only change besides the header; bun and tsc (bundler resolution) both
 * resolve the extensionless form.
 */
export const dropJsSpecifiers = (src: string): string => src.replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*?)\.js\2/g, '$1$2$3$2');
