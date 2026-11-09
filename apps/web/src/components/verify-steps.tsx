/**
 * The verify page while it checks: a horizontal track of the five steps, and under it a small scene that acts out the
 * step the verifier is on (the record read, the key signing, the payment moving between wallets, the time window, the
 * registry binding). Steps move only when the verifier actually reaches them (verify-record.tsx); the scenes are
 * illustrations of what that step checks, drawn from the record's own values.
 */
import type { ReactNode } from 'react';
import { formatUsdc } from '@/lib/explore';
import { shorten } from '@/lib/format';
import type { CheckName } from '@/lib/verify-record';

export type StepKey = 'record' | CheckName;
export type StepState = 'pending' | 'running' | 'pass' | 'fail' | 'skipped';
export type Steps = Record<StepKey, StepState>;

export const START_STEPS: Steps = { record: 'running', signature: 'pending', settlement: 'pending', timing: 'pending', identity: 'pending' };

/** What the steps can name once the record is in hand. */
export interface StepsRecord {
  agent: { address: string; agentId?: string };
  settlement: { ref: string; amount: string; asset: string; payer?: string };
  output?: { sha256?: string };
  issuedAt?: string;
}

export const ORDER: StepKey[] = ['record', 'signature', 'settlement', 'timing', 'identity'];

const LABEL: Record<StepKey, string> = { record: 'Record', signature: 'Signature', settlement: 'Payment', timing: 'Timing', identity: 'Owner' };

/** The step the scene shows: the one running, else the last one that ended, else the first. */
export function focusStep(steps: Steps): StepKey {
  const running = ORDER.find((k) => steps[k] === 'running');
  if (running) return running;
  const ended = ORDER.filter((k) => steps[k] !== 'pending');
  return ended[ended.length - 1] ?? 'record';
}

function caption(key: StepKey, s: StepState, r: StepsRecord | null): string {
  const amount = r ? `${formatUsdc(r.settlement.amount)} ${r.settlement.asset.split(':')[0]}` : 'the payment';
  const id = r?.agent.agentId ? `agent #${r.agent.agentId}` : 'the agent';
  const done = s === 'pass';
  const failed = s === 'fail';
  switch (key) {
    case 'record':
      return done ? 'Record read: it names the agent, the payment, and the hashes of what was asked and returned.' : 'Reading the signed record…';
    case 'signature':
      return failed ? "The signature does not match the agent's key." : done ? `Signed by ${id}'s key. Change one byte and this fails.` : "Checking the signature against the agent's public key…";
    case 'settlement':
      return failed ? 'No matching payment on Stellar testnet.' : done ? `${amount} reached the agent on Stellar testnet.` : 'Finding the payment on Stellar testnet…';
    case 'timing':
      return failed ? 'Signed too far from the payment.' : done ? 'Signed within a day of the payment.' : 'Comparing the signing time with the payment time…';
    case 'identity':
      return failed ? 'The identity registry does not bind this agent.' : s === 'skipped' ? 'The record names no registered agent.' : done ? `The registry binds ${id} to its owner.` : `Looking up ${id} in the identity registry…`;
  }
}

const ICON: Record<StepKey, ReactNode> = {
  record: <path d="M6 3h6l4 4v10H6zM12 3v4h4M8.5 10.5h5M8.5 13.5h5" />,
  signature: <path d="M8 13.5a3.5 3.5 0 1 1 0-.01M11.3 12H18M15.5 12v2.5M17.5 12v2" />,
  settlement: <path d="M11 4a7 7 0 1 0 .01 0M11 7v8M13.5 8.8c-.6-.8-1.5-1.1-2.5-1.1-1.4 0-2.3.7-2.3 1.7 0 2.4 5 1.3 5 3.6 0 1-1 1.8-2.6 1.8-1.1 0-2.1-.4-2.8-1.2" />,
  timing: <path d="M11 4a7 7 0 1 0 .01 0M11 7.5V11l2.5 2" />,
  identity: <path d="M11 4.5a3 3 0 1 0 .01 0M5.5 17.5c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />,
};

function Scene({ step, state, r }: { step: StepKey; state: StepState; r: StepsRecord | null }) {
  const out = r?.output?.sha256 ?? '';
  const agent = r ? shorten(r.agent.address, 4, 4) : 'G…';
  const payer = r?.settlement.payer ? shorten(r.settlement.payer, 4, 4) : 'payer';
  const tx = r ? shorten(r.settlement.ref, 4, 4) : '';
  const amount = r ? `${formatUsdc(r.settlement.amount)} ${r.settlement.asset.split(':')[0]}` : '';
  return (
    <svg viewBox="0 0 600 180" className="vscene" data-step={step} data-state={state} role="img" aria-label={LABEL[step]}>
      {step === 'record' ? (
        <g>
          <g className="vs-doc">
            <rect x="232" y="18" width="136" height="148" rx="10" className="vs-paper" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={i} x="252" y={44 + i * 18} width={i % 2 ? 72 : 96} height="6" rx="3" className="vs-bar" style={{ animationDelay: `${i * 90}ms` }} />
            ))}
            <rect x="236" y="22" width="128" height="10" className="vs-scan" />
          </g>
          <text x="392" y="70" className="vs-mono vs-fade">sha256(output)</text>
          <text x="392" y="90" className="vs-mono vs-fade vs-strong" style={{ animationDelay: '250ms' }}>{out ? shorten(out, 8, 6) : '…'}</text>
          <text x="392" y="118" className="vs-mono vs-fade" style={{ animationDelay: '400ms' }}>agent {agent}</text>
          <text x="392" y="138" className="vs-mono vs-fade" style={{ animationDelay: '550ms' }}>tx {tx}</text>
        </g>
      ) : null}
      {step === 'signature' ? (
        <g>
          <rect x="150" y="18" width="136" height="148" rx="10" className="vs-paper" />
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x="170" y={44 + i * 18} width={i % 2 ? 72 : 96} height="6" rx="3" className="vs-bar vs-still" />
          ))}
          <path d="M172 136c10-14 18-14 20-2s10 6 16-6 12-2 14 6 10 0 18-6" className="vs-sig" />
          <g className="vs-key">
            <circle cx="420" cy="92" r="16" className="vs-ink" />
            <circle cx="420" cy="92" r="6" className="vs-hole" />
            <rect x="436" y="88" width="56" height="8" rx="2" className="vs-ink" />
            <rect x="476" y="96" width="6" height="12" className="vs-ink" />
            <rect x="486" y="96" width="6" height="9" className="vs-ink" />
          </g>
          <text x="340" y="160" className="vs-mono vs-fade" style={{ animationDelay: '500ms' }}>ed25519 · {agent}</text>
        </g>
      ) : null}
      {step === 'settlement' ? (
        <g>
          <line x1="130" y1="80" x2="470" y2="80" className="vs-rail" />
          <g>
            <circle cx="110" cy="80" r="26" className="vs-node" />
            <text x="110" y="132" className="vs-mono vs-mid">{payer}</text>
            <text x="110" y="150" className="vs-label vs-mid">payer</text>
          </g>
          <g>
            <circle cx="490" cy="80" r="26" className="vs-node vs-node-to" />
            <text x="490" y="132" className="vs-mono vs-mid">{agent}</text>
            <text x="490" y="150" className="vs-label vs-mid">agent</text>
          </g>
          <g className="vs-coin">
            <circle cx="130" cy="80" r="12" className="vs-coin-face" />
            <text x="130" y="84.5" className="vs-coin-mark vs-mid">$</text>
          </g>
          <text x="300" y="62" className="vs-mono vs-mid vs-strong">{amount}</text>
          <text x="300" y="112" className="vs-mono vs-mid vs-fade" style={{ animationDelay: '400ms' }}>tx {tx} · Horizon</text>
        </g>
      ) : null}
      {step === 'timing' ? (
        <g>
          <line x1="80" y1="96" x2="520" y2="96" className="vs-rail" />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} x1={80 + i * 40} y1="90" x2={80 + i * 40} y2="102" className="vs-tick" />
          ))}
          <rect x="200" y="86" width="200" height="20" rx="10" className="vs-window" />
          <g className="vs-pin">
            <circle cx="260" cy="96" r="7" className="vs-ink" />
            <text x="260" y="70" className="vs-label vs-mid">paid</text>
          </g>
          <g className="vs-pin" style={{ animationDelay: '350ms' }}>
            <circle cx="300" cy="96" r="7" className="vs-ok-fill" />
            <text x="300" y="134" className="vs-label vs-mid">signed</text>
          </g>
          <text x="300" y="160" className="vs-mono vs-mid vs-fade" style={{ animationDelay: '600ms' }}>within ± 24 h</text>
        </g>
      ) : null}
      {step === 'identity' ? (
        <g>
          <line x1="140" y1="84" x2="460" y2="84" className="vs-rail" />
          <line x1="140" y1="84" x2="460" y2="84" className="vs-bind" />
          <g>
            <circle cx="110" cy="84" r="26" className="vs-node" />
            <text x="110" y="136" className="vs-mono vs-mid">{agent}</text>
            <text x="110" y="154" className="vs-label vs-mid">agent wallet</text>
          </g>
          <g>
            <rect x="250" y="60" width="100" height="48" rx="8" className="vs-paper" />
            <text x="300" y="82" className="vs-label vs-mid">registry</text>
            <text x="300" y="99" className="vs-mono vs-mid vs-strong">{r?.agent.agentId ? `#${r.agent.agentId}` : '—'}</text>
          </g>
          <g className="vs-owner">
            <circle cx="490" cy="84" r="26" className="vs-node vs-node-to" />
            <text x="490" y="136" className="vs-label vs-mid">owner wallet</text>
          </g>
        </g>
      ) : null}
    </svg>
  );
}

export function VerifySteps({ steps, record }: { steps: Steps; record: StepsRecord | null }) {
  const focus = focusStep(steps);
  return (
    <div className="mt-10" aria-busy="true">
      <p className="headline text-[clamp(1.5rem,2.6vw,2rem)]">Checking the proof…</p>
      <p className="mt-3 max-w-2xl text-[15px] text-fg-2">Your browser checks it step by step against public Stellar testnet data. Nothing goes through us.</p>
      <div className="card mt-8 p-5 sm:p-8">
        <ol className="vtrack">
          {ORDER.map((k) => (
            <li key={k} className="vnode" data-state={steps[k]} aria-current={k === focus ? 'step' : undefined}>
              <span className="vnode-ring" aria-hidden>
                <svg viewBox="0 0 22 22" className="vnode-icon">
                  {steps[k] === 'pass' ? <path d="M6 11.5l3.5 3.5 6.5-8" className="vnode-check" /> : steps[k] === 'fail' ? <path d="M7 7l8 8M15 7l-8 8" /> : ICON[k]}
                </svg>
              </span>
              <span className="vnode-label">{LABEL[k]}</span>
              <span className="sr-only"> {steps[k]}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 sm:mt-8">
          <Scene key={focus} step={focus} state={steps[focus]} r={record} />
        </div>
        <p className="mt-4 min-h-[3em] text-center text-[15px] text-fg-2" aria-live="polite">
          {caption(focus, steps[focus], record)}
        </p>
      </div>
    </div>
  );
}
