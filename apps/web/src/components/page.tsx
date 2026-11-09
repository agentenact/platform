/**
 * The centered column every screen sits in. flow = 680px, wide = the first screen's two columns, cockpit = the agent's
 * working screen (rail, work, side panel), which uses the width of the window up to 1400px.
 */
export function Page({ children, width = 'flow' }: { children: React.ReactNode; width?: 'flow' | 'wide' | 'cockpit' }) {
  if (width === 'cockpit') return <main className="mx-auto w-full max-w-[1400px] px-3 pt-4 pb-16 sm:px-5 md:pt-6">{children}</main>;
  return <main className={`mx-auto w-full px-5 pt-8 pb-16 md:pt-12 ${width === 'wide' ? 'max-w-5xl' : 'max-w-[680px]'}`}>{children}</main>;
}
