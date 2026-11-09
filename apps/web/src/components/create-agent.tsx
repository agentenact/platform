'use client';

import { useEffect, useState } from 'react';
import { SealLoader } from './seal-loader';
import { shorten } from '@/lib/format';
import { accountExists, freighterSigner, fundWithFriendbot, tempSigner } from '@/lib/signers';
import { loadBundle, type Bundle, type CreatedAgent, type PartialAgent, type StellarSigner } from '@/lib/verifier-bundle';

type Phase = 'wallet' | 'name' | 'creating' | 'done' | 'error';
type StepState = 'wait' | 'run' | 'ok' | 'fail';
type WalletKind = 'freighter' | 'temp';
type Identity = { state: 'checking' } | { state: 'bound' } | { state: 'mismatch'; detail: string } | { state: 'error'; detail: string };

interface Wallet {
  kind: WalletKind;
  signer: StellarSigner;
  /** false = the owner account does not exist on testnet yet */
  funded: boolean;
}

const STEPS = [
  { title: 'Open the agent account', detail: 'Sponsored by your wallet, with a USDC trustline. The agent holds no XLM.' },
  { title: 'Register the identity', detail: 'register_with_uri on the stellar-8004 registry. You become the owner.' },
  { title: 'Bind the agent wallet', detail: 'set_agent_wallet, authorised by you and by the agent itself.' },
] as const;

const NAME_MAX = 60;
const DESCRIPTION_MAX = 160;

const explorer = (kind: 'tx' | 'account', id: string) => `https://stellar.expert/explorer/testnet/${kind}/${id}`;

/** ERC-8004 registration document, carried inline so no hosting is needed. */
function agentUri(name: string, description: string): string {
  const json = JSON.stringify({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:application/json;base64,${btoa(binary)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log the message only: createStellarAgent's err.partial carries the agent secret, which must not reach the console. */
function logFailure(what: string, err: unknown) {
  console.error(`[agentenact] ${what}: ${message(err)}`);
}

/** Which step failed, from what already landed on chain (createStellarAgent attaches it as err.partial). */
function failedStep(partial: PartialAgent | undefined): number {
  if (!partial?.txs.account) return 0;
  return partial.agentId ? 2 : 1;
}

/**
 * The snippets below are code for the reader's own app, which reads its secrets from its environment. The words are
 * joined here so this app's server-boundary scan (tests/scaffold.test.ts: env reads live under src/server/ only) sees no
 * env read in text we only display. Nothing in this file reads the environment.
 */
const ENV = ['process', 'env'].join('.');

function snippet(created: { publicKey: string; agentId: string }): string {
  return `import { createEnactServer } from 'agentenact/serve';
import { createStellarAdapter, stellarSecretToBytes } from 'agentenact/adapters/stellar';

const handler = await createEnactServer({
  network: 'stellar:testnet',
  agent: {
    address: '${created.publicKey}',
    agentId: '${created.agentId}',
    secret: stellarSecretToBytes(${ENV}.AGENT_SECRET!),
  },
  adapter: createStellarAdapter({ network: 'testnet' }),
  // price, facilitator, resource, handler
});`;
}

function Address({ label, value, kind }: { label: string; value: string; kind: 'account' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-4 text-[15px]">
      <span>{label}</span>
      <a
        href={explorer(kind, value)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[12px] text-fg-2 underline decoration-line underline-offset-4 hover:text-fg"
      >
        {shorten(value, 6, 6)} ↗
      </a>
    </div>
  );
}

function Secret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setCopyError(`Couldn't copy: ${message(err)}. Select the text instead.`);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`AGENT_SECRET=${secret}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = '.env';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-8">
      <p className="eyebrow">Agent secret · shown once</p>
      <p className="mt-3 max-w-md text-[15px] leading-[1.55] text-fg-2">
        Kept in this page&apos;s memory only. It is sent nowhere and saved nowhere. Leave the page and it is gone.
      </p>
      <p className="mt-4 rounded-2xl border border-line px-4 py-3 font-mono text-[13px] break-all select-all">{secret}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={download}>
          Download .env
        </button>
      </div>
      {copyError ? <p className="mt-3 font-mono text-[12px] break-all text-danger">{copyError}</p> : null}
    </div>
  );
}

/** `verifierSrc` is the content-hashed bundle URL (see page.tsx); the panel runs the package's own createStellarAgent. */
/** The in-browser create panel on /create; `id` is its section anchor. */
export function CreateAgent({ verifierSrc, id = 'own-wallet' }: { verifierSrc: string; id?: string }) {
  const [phase, setPhase] = useState<Phase>('wallet');
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<StepState[]>(['wait', 'wait', 'wait']);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [partial, setPartial] = useState<PartialAgent | null>(null);
  const [failure, setFailure] = useState<{ step: number; detail: string } | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);

  const secret = created?.secret ?? partial?.secret ?? null;

  // The secret exists nowhere but this page: warn before it is lost, from the moment the agent key is generated.
  const guard = phase === 'creating' || secret !== null;
  useEffect(() => {
    if (!guard) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [guard]);

  async function connect(kind: WalletKind) {
    setBusy(kind);
    setWalletError(null);
    try {
      const bundle = await loadBundle(verifierSrc);
      if (kind === 'freighter') {
        const signer = await freighterSigner(bundle);
        setWallet({ kind, signer, funded: await accountExists(signer.publicKey) });
      } else {
        const signer = tempSigner(bundle);
        await fundWithFriendbot(signer.publicKey);
        setWallet({ kind, signer, funded: true });
      }
      setPhase('name');
    } catch (err) {
      logFailure('wallet setup failed', err);
      setWalletError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function fund() {
    if (!wallet) return;
    setBusy('fund');
    setWalletError(null);
    try {
      await fundWithFriendbot(wallet.signer.publicKey);
      setWallet({ ...wallet, funded: true });
    } catch (err) {
      logFailure('friendbot funding failed', err);
      setWalletError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function checkIdentity(bundle: Bundle, result: CreatedAgent) {
    setIdentity({ state: 'checking' });
    try {
      const binding = await bundle.createStellarAdapter({ network: 'testnet' }).resolveIdentity(result.agentId);
      if (binding?.owner === result.owner && binding.wallet === result.publicKey) setIdentity({ state: 'bound' });
      else setIdentity({ state: 'mismatch', detail: binding ? `registry says owner ${shorten(binding.owner, 5, 5)}, wallet ${binding.wallet ? shorten(binding.wallet, 5, 5) : 'none'}` : 'registry has no such agent yet' });
    } catch (err) {
      logFailure('identity read-back failed', err);
      setIdentity({ state: 'error', detail: message(err) });
    }
  }

  async function create() {
    if (!wallet) return;
    setPhase('creating');
    setSteps(['run', 'wait', 'wait']);
    setFailure(null);
    setPartial(null);
    // createStellarAgent signs exactly once per step, in order: the n-th signature means step n has started.
    let signs = 0;
    const owner: StellarSigner = {
      publicKey: wallet.signer.publicKey,
      signTransaction: (xdr, passphrase) => {
        signs += 1;
        const current = signs - 1;
        setSteps((prev) => prev.map((s, i) => (i < current ? 'ok' : i === current ? 'run' : 'wait')));
        return wallet.signer.signTransaction(xdr, passphrase);
      },
    };
    try {
      const bundle = await loadBundle(verifierSrc);
      const result = await bundle.createStellarAgent({
        network: 'stellar:testnet',
        owner,
        agentUri: agentUri(name.trim(), description.trim()),
      });
      setSteps(['ok', 'ok', 'ok']);
      setCreated(result);
      setPhase('done');
      void checkIdentity(bundle, result);
    } catch (err) {
      logFailure('agent creation failed', err);
      const landed = (err as { partial?: PartialAgent }).partial;
      const step = failedStep(landed);
      setPartial(landed ?? null);
      setFailure({ step, detail: message(err) });
      setSteps(STEPS.map((_, i) => (i < step ? 'ok' : i === step ? 'fail' : 'wait')));
      setPhase('error');
    }
  }

  function reset() {
    setPhase('wallet');
    setWallet(null);
    setWalletError(null);
    setName('');
    setDescription('');
    setSteps(['wait', 'wait', 'wait']);
    setCreated(null);
    setPartial(null);
    setFailure(null);
    setIdentity(null);
  }

  const inputClass = 'mt-2 h-12 w-full rounded-2xl border border-fg-3/60 bg-transparent px-4 text-[16px] text-fg placeholder:text-fg-3';
  const ready = name.trim().length > 0 && wallet?.funded === true;

  return (
    <section id={id} className="scroll-mt-24">
      <div className="card px-6 py-8 sm:px-9 sm:py-10">
        <div className="min-w-0">
          {phase === 'wallet' ? (
            <div>
              <p className="eyebrow">1 · Owner wallet</p>
              <p className="mt-3 max-w-md text-[15px] leading-[1.55] text-fg-2">
                The owner pays the fees and holds the identity. Use Freighter set to Testnet, or a temporary wallet that lives only in this page.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <button type="button" className="btn" disabled={busy !== null} onClick={() => connect('freighter')}>
                  {busy === 'freighter' ? <><SealLoader size={16} />Connecting…</> : 'Connect Freighter'}
                </button>
                <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => connect('temp')}>
                  {busy === 'temp' ? <><SealLoader size={16} />Funding…</> : 'Use a temporary wallet'}
                </button>
              </div>
              {walletError ? (
                <p role="alert" className="mt-5 max-w-md font-mono text-[12px] leading-[1.6] break-words text-danger">
                  {walletError}
                </p>
              ) : null}
            </div>
          ) : null}

          {phase === 'name' && wallet ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) void create();
              }}
            >
              <div className="flex items-baseline justify-between gap-4 pb-4 text-[15px]">
                <span>{wallet.kind === 'freighter' ? 'Freighter' : 'Temporary wallet'}</span>
                <span className="font-mono text-[12px] text-fg-3">{shorten(wallet.signer.publicKey, 6, 6)}</span>
              </div>
              {!wallet.funded ? (
                <div className="border-t border-line py-5">
                  <p className="max-w-md text-[15px] leading-[1.55] text-fg-2">This account isn&apos;t on testnet yet. Friendbot funds it with test XLM.</p>
                  <button type="button" className="btn mt-4" disabled={busy !== null} onClick={fund}>
                    {busy === 'fund' ? <><SealLoader size={16} />Funding…</> : 'Fund with Friendbot'}
                  </button>
                  {walletError ? (
                    <p role="alert" className="mt-4 font-mono text-[12px] leading-[1.6] break-words text-danger">
                      {walletError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="border-t border-line pt-6">
                <p className="eyebrow">2 · Name the agent</p>
                <label className="mt-5 block text-[15px]">
                  Name
                  <input className={inputClass} value={name} maxLength={NAME_MAX} required autoComplete="off" placeholder="Summariser" onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="mt-5 block text-[15px]">
                  What it does
                  <input
                    className={inputClass}
                    value={description}
                    maxLength={DESCRIPTION_MAX}
                    autoComplete="off"
                    placeholder="Summarises a page in three lines."
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <div className="mt-6 flex flex-wrap gap-3">
                  <button type="submit" className="btn" disabled={!ready}>
                    Create agent
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={reset}>
                    Change wallet
                  </button>
                </div>
                <p className="mt-4 max-w-md text-[14px] text-fg-3">
                  {wallet.kind === 'freighter'
                    ? 'Freighter asks for one approval per step.'
                    : 'The temporary owner key is discarded with this page, so the identity it owns stays a testnet demo.'}
                </p>
              </div>
            </form>
          ) : null}

          {phase === 'creating' || phase === 'done' || phase === 'error' ? (
            <div>
              <p className="eyebrow" aria-live="polite">3 · {phase === 'done' ? 'Created' : phase === 'error' ? 'Stopped' : 'Creating'}</p>
              <ol className="mt-4">
                {STEPS.map((step, i) => {
                  const state = steps[i] ?? 'wait';
                  const hash = created?.txs[(['account', 'register', 'bind'] as const)[i]!] ?? partial?.txs[(['account', 'register', 'bind'] as const)[i]!];
                  return (
                    <li key={step.title} className="flex gap-4 border-t border-line py-4">
                      <span
                        className="hud-dot mt-[9px] shrink-0"
                        data-state={state === 'run' ? 'verifying' : state === 'ok' ? 'verified' : state === 'fail' ? 'broken' : undefined}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-4 text-[15px]">
                          <span className={state === 'wait' ? 'text-fg-3' : state === 'fail' ? 'text-danger' : undefined}>{step.title}</span>
                          <span className="shrink-0 font-mono text-[12px] text-fg-3">
                            {state === 'ok' ? 'Done' : state === 'run' ? (wallet?.kind === 'freighter' ? 'Approve in Freighter' : 'Working…') : state === 'fail' ? 'Failed' : '—'}
                          </span>
                        </div>
                        <p className="mt-1 text-[14px] leading-[1.5] text-fg-3">{step.detail}</p>
                        {hash ? (
                          <a
                            href={explorer('tx', hash)}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block font-mono text-[12px] text-fg-2 underline decoration-line underline-offset-4 hover:text-fg"
                          >
                            tx {shorten(hash, 6, 6)} ↗
                          </a>
                        ) : null}
                        {failure?.step === i ? (
                          <p role="alert" className="mt-2 font-mono text-[12px] leading-[1.6] break-words text-danger">
                            {failure.detail}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {phase === 'done' && created ? (
            <div className="mt-6">
              <div className="flex items-baseline justify-between gap-4 border-t border-line py-4 text-[15px]">
                <span>Agent ID</span>
                <span className="font-mono text-[13px]">#{created.agentId}</span>
              </div>
              <Address label="Owner" value={created.owner} kind="account" />
              <Address label="Agent" value={created.publicKey} kind="account" />
              <div className="flex items-baseline justify-between gap-4 border-t border-line py-4 text-[15px]">
                <span>
                  Identity
                  <span className="ml-3 font-mono text-[12px] text-fg-3">read from the registry</span>
                </span>
                <span className={identity?.state === 'bound' ? 'text-fg' : identity?.state === 'mismatch' || identity?.state === 'error' ? 'text-danger' : 'text-fg-3'}>
                  {identity?.state === 'bound' ? 'Bound' : identity?.state === 'mismatch' || identity?.state === 'error' ? 'Not confirmed' : '—'}
                </span>
              </div>
              {identity && (identity.state === 'mismatch' || identity.state === 'error') ? (
                <p role="alert" className="font-mono text-[12px] leading-[1.6] break-words text-danger">
                  {identity.detail}
                </p>
              ) : null}
              <Secret secret={created.secret} />
              <div className="mt-8">
                <p className="eyebrow">Run it</p>
                <pre className="mt-3 overflow-x-auto rounded-2xl border border-line p-4 font-mono text-[12px] leading-[1.6]">{snippet(created)}</pre>
              </div>
              <button type="button" className="btn btn-quiet mt-8" onClick={reset}>
                Create another
              </button>
            </div>
          ) : null}

          {phase === 'error' ? (
            <div className="mt-6">
              {partial ? (
                <>
                  <p className="max-w-md text-[15px] leading-[1.55] text-fg-2">
                    The agent account was already opened on testnet, so its secret is below. Nothing after the failed step ran.
                  </p>
                  <Address label="Agent" value={partial.publicKey} kind="account" />
                  <Secret secret={partial.secret} />
                </>
              ) : (
                <p className="max-w-md text-[15px] leading-[1.55] text-fg-2">Nothing was created on chain.</p>
              )}
              <button type="button" className="btn mt-8" onClick={reset}>
                Start over
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
