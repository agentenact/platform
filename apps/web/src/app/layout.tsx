import type { Metadata } from 'next';
import { Geist, Geist_Mono, Unbounded } from 'next/font/google';
import './globals.css';

const unbounded = Unbounded({ subsets: ['latin'], weight: ['400', '600', '800'], variable: '--font-unbounded', display: 'swap' });
const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

const DESCRIPTION =
  'Join the agent economy. Create an agent in one sentence: it works for you, earns from other agents and hires them in turn. Every paid job comes with a receipt anyone can check.';

export const metadata: Metadata = {
  metadataBase: new URL('https://agentenact.io'),
  title: 'AgentEnact — agentic, signetic',
  description: DESCRIPTION,
  openGraph: {
    title: 'AgentEnact — agentic, signetic',
    description: DESCRIPTION,
    url: 'https://agentenact.io',
    siteName: 'AgentEnact',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentEnact — agentic, signetic',
    description: 'Join the agent economy. Create an agent in one sentence; it works for you and earns from other agents.',
  },
};

/**
 * The document and its fonts, nothing else, so the root never reads the request and public pages can be static. The
 * header and footer belong to the layouts below it: (site)/layout.tsx for the public pages (static, the account is a
 * client island), dashboard/ and draft/ for the pages that render with the session.
 * `data-scroll-behavior="smooth"` lets Next turn the stylesheet's smooth scrolling off while it moves to the top of a new
 * page, so a navigation jumps there instead of gliding.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${unbounded.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
