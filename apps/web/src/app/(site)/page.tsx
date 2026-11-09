import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { HomeView } from '@/components/home-screen';
import type { CapturedProof } from '@/lib/proof-types';
import { verifierSrc } from '@/lib/verifier-src';

export const metadata: Metadata = { alternates: { canonical: 'https://agentenact.io' } };

let proof: CapturedProof | undefined;

/** The captured proof the Live proof section re-checks in the browser (public/proofs/latest.json), read once. */
function loadProof(): CapturedProof {
  proof ??= JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'proofs', 'latest.json'), 'utf8')) as CapturedProof;
  return proof;
}

/** Static: nothing here reads the request (`?signin=` is handled in the browser, see components/home-sign-in.tsx). */
export default function Home() {
  return <HomeView proof={loadProof()} verifierSrc={verifierSrc()} />;
}
