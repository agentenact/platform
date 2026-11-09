'use client';
import { usePathname } from 'next/navigation';
import { isOwnShellPath } from '@/lib/own-shell';

/** Renders its children except inside a section with its own shell (lib/own-shell.ts); used by the root 404 and error pages. */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return isOwnShellPath(usePathname() ?? '') ? null : children;
}
