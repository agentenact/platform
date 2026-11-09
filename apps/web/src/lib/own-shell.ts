/**
 * Sections of this app that bring their own shell instead of the site's: the proxy passes them through untouched (no session
 * refresh), the router never opens them in place, and the root 404 and error pages leave out the site header and footer on
 * them. This build has none; a build that adds such a section replaces this file.
 */
export const OWN_SHELL_SECTIONS: readonly string[] = [];

/** Whether `pathname` is inside one of OWN_SHELL_SECTIONS (`/x` or `/x/...`). */
export const isOwnShellPath = (pathname: string): boolean =>
  OWN_SHELL_SECTIONS.some((s) => pathname === `/${s}` || pathname.startsWith(`/${s}/`));
