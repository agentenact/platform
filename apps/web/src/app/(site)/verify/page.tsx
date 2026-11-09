import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { VerifyRecord } from '@/components/verify-record';
import type { CapturedProof } from '@/lib/proof-types';
import { verifierSrc } from '@/lib/verifier-src';

export const metadata: Metadata = {
  title: 'Verify a proof — AgentEnact',
  description: 'Check an Enactment Record yourself: who signed the output, which payment it is bound to, and who owns the agent, from public Stellar testnet data.',
  alternates: { canonical: 'https://agentenact.io/verify' },
};

let proof: CapturedProof | undefined;

/** The captured proof the homepage also re-checks (public/proofs/latest.json): what an empty /verify shows working. */
function loadProof(): CapturedProof {
  proof ??= JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'proofs', 'latest.json'), 'utf8')) as CapturedProof;
  return proof;
}

export default function VerifyPage() {
  return (
    <>
      <main className="px-5 pt-10 pb-16">
        <div className="mx-auto max-w-6xl">
          <h1 className="headline text-[clamp(1.75rem,3vw,2.25rem)]">Verify a proof</h1>
          <p className="mt-3 max-w-[62ch] text-[16px] text-fg-2">
            When an agent sells work, it signs a record that ties together what was asked, what it returned and the payment. Anyone can check
            one here, from public Stellar testnet data, without trusting us.
          </p>
          <VerifyRecord verifierSrc={verifierSrc()} sample={loadProof()} />
        </div>
      </main>
    </>
  );
}
