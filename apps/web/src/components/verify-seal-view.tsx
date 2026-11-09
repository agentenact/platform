'use client';

import { useId, useState, type FormEvent } from 'react';
import { shorten } from '@/lib/format';
import { describeDoc, matchDocument, type ChainTx, type DocMatch } from '@/lib/verify-seal';
import { AppLink } from '@/components/app-link';
import { Seal } from './seal';

const explorer = (tx: string) => `https://stellar.expert/explorer/testnet/tx/${tx}`;
const when = (iso: string) => new Date(iso).toUTCString().replace('GMT', 'UTC');

const NOT_SHOWN = [
  'Whether the reading or the decision was right.',
  "What the document says, until someone who holds it pastes it here. The chain carries only its hash, and a salt inside it stops anyone from guessing the contents.",
  'That it came first: a decision is sealed after its run ends, so it binds what the run did, not when it was decided.',
];

/** A seal read from the chain, and a field for its document: the owner's copy is hashed here and compared to the memo. */
export function SealView({ tx, agentId }: { tx: ChainTx; agentId: number | null }) {
  const id = useId();
  const [text, setText] = useState('');
  const [match, setMatch] = useState<DocMatch | null>(null);
  const memo = tx.memoHash!;
  const sponsored = tx.feeAccount !== tx.source;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMatch(text.trim() ? await matchDocument(text, memo, tx.source) : null);
  };
  const shown = match?.ok ? describeDoc(match.doc) : null;

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-14" aria-live="polite">
      <div className="min-w-0">
        <p className="headline text-[clamp(1.5rem,2.6vw,2rem)]">This is an agent&apos;s seal.</p>
        <p className="mt-3 max-w-xl text-[15px] text-fg-2">
          {agentId !== null ? <>Agent #{agentId}</> : 'An agent'} committed one hash on Stellar testnet on {when(tx.at)}. Its own key signed the
          transaction, so nobody else could have sent it, and neither the hash nor the time can change now. A seal moves no money.
        </p>

        <div className="card mt-8 divide-y divide-line p-0">
          {[
            ['Signed by', agentId !== null ? `agent #${agentId}'s key` : `${shorten(tx.source, 4, 4)}'s key`, 'Valid'],
            ['On chain', `ledger ${tx.ledger}`, 'Final'],
            ['Committed hash', shorten(memo, 8, 8), shown ? 'Matches the document' : 'Hidden'],
          ].map(([label, detail, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 px-5 py-3.5 text-[14px]">
              <span className="min-w-0">
                {label}
                <span className="ml-3 font-mono text-[11px] break-all text-fg-3">{detail}</span>
              </span>
              <span className={`shrink-0 ${value === 'Hidden' ? 'text-fg-3' : 'text-ok'}`}>{value}</span>
            </div>
          ))}
        </div>

        <form onSubmit={(e) => void submit(e)} className="mt-12 max-w-xl" noValidate>
          <h2 className="headline text-[clamp(1.25rem,2vw,1.5rem)]">See what was sealed</h2>
          <p className="mt-3 text-[15px] text-fg-2">
            The document behind the hash stays with the agent&apos;s owner, because a check can hold private readings. If you have it (the
            day&apos;s download on the agent&apos;s Activity), paste it. It is hashed here and never sent anywhere.
          </p>
          <label htmlFor={id} className="mt-5 block text-[15px]">
            Seal document or day file
          </label>
          <textarea
            id={id}
            className="ex-search !m-0 mt-2 !h-28 w-full resize-y py-3 font-mono text-[13px]"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMatch(null);
            }}
            spellCheck={false}
            placeholder='{"agent":"G…","at":"…","salt":"…","v":"ae.check/1",…}'
          />
          <button type="submit" className="btn btn-sm mt-3">
            Check the document
          </button>
          {match && !match.ok ? (
            <p role="status" className="mt-4 text-[15px] text-danger">
              {match.reason === 'not_json'
                ? "That isn't JSON. Paste the document or the downloaded file as it is."
                : match.reason === 'other_agent'
                  ? 'That document hashes right but names another agent than the one that sent this seal.'
                  : 'No document in it matches this seal. It may belong to another seal or another day.'}
            </p>
          ) : null}
          {shown ? (
            <div role="status" className="mt-6">
              <p className="text-[15px] text-ok">It matches. This is exactly what the agent sealed.</p>
              <dl className="card mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 p-5 text-[14px]">
                <dt className="text-fg-3">What</dt>
                <dd>{shown.kind}</dd>
                {shown.rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-fg-3">{k}</dt>
                    <dd className="font-mono text-[13px] break-all">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </form>

        <div className="mt-10 max-w-xl text-[14px] text-fg-2">
          <p className="text-fg-3">What a seal does not show</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {NOT_SHOWN.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>

      <aside className="min-w-0" aria-label="The seal on chain">
        <Seal hash={tx.hash} label="Seal of this transaction" className="w-full max-w-[96px] lg:max-w-[200px]" mark="var(--ground)" />
        <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-[14px]">
          {agentId !== null ? (
            <>
              <dt className="text-fg-3">Agent</dt>
              <dd>
                <AppLink href={`/agents/${agentId}`} className="underline decoration-line underline-offset-4 hover:text-fg">
                  agent #{agentId}
                </AppLink>
              </dd>
            </>
          ) : null}
          <dt className="text-fg-3">Account</dt>
          <dd className="font-mono text-[13px] break-all">{shorten(tx.source, 6, 6)}</dd>
          <dt className="text-fg-3">Sealed</dt>
          <dd>{when(tx.at)}</dd>
          {sponsored ? (
            <>
              <dt className="text-fg-3">Fee paid by</dt>
              <dd className="font-mono text-[13px] break-all">{shorten(tx.feeAccount, 6, 6)}</dd>
            </>
          ) : null}
          <dt className="text-fg-3">Transaction</dt>
          <dd>
            <a href={explorer(tx.hash)} target="_blank" rel="noreferrer" className="font-mono text-[13px] underline decoration-line underline-offset-4 hover:text-fg">
              {shorten(tx.hash, 8, 8)} ↗
            </a>
          </dd>
        </dl>
      </aside>
    </div>
  );
}
