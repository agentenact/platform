import { shorten } from '@/lib/format';
import { KeyGlyph, OwnerGlyph, RecordGlyph } from './glyphs';

type CheckState = 'pending' | 'pass' | 'fail' | 'skipped';
type PortState = 'idle' | 'true' | 'fail';

/** How long a beam takes to reach the next wallet; matches `.beam-fill` in globals.css. */
const ARRIVE_MS = 450;

/**
 * record ─01 signed─ agent wallet ─02 owner #N─ owner wallet, drawn as a quiet line diagram.
 *
 * Beam 01 is the verifier's `signature` check, beam 02 its `identity` check.
 * When the verifier answers, the path draws itself left to right and each
 * wallet lights as its beam arrives; a failing beam draws broken, in danger red.
 * Nothing here is decided by the page.
 */
export function WalletChain({
  running,
  signature,
  identity,
  agent,
  agentId,
  owner,
}: {
  running: boolean;
  signature: CheckState;
  identity: CheckState;
  agent: string;
  agentId?: string;
  owner: string | null;
}) {
  const status = running ? 'Verifying' : signature === 'fail' || identity === 'fail' ? 'Broken' : identity === 'pass' ? 'Verified' : 'Standby';
  const tone = status === 'Broken' ? 'text-danger' : status === 'Verified' ? 'text-fg' : 'text-fg-2';
  const port = (state: CheckState): PortState => (state === 'pass' ? 'true' : state === 'fail' ? 'fail' : 'idle');

  return (
    <div className="relative">
      <div className="flex items-center justify-between font-mono text-[12px]">
        <span className="text-fg-3">Verification path</span>
        <span className={`flex items-center gap-2 transition-colors duration-500 ${tone}`}>
          <span className="hud-dot" data-state={status.toLowerCase()} aria-hidden />
          {status}
        </span>
      </div>

      <div className="mt-7 flex flex-col md:flex-row md:items-start">
        <Port Glyph={RecordGlyph} label="Signed record" value="this output" state={port(signature)} delay={0} />
        <Beam index="01" label="signed" state={signature} delay={0} />
        <Port Glyph={KeyGlyph} label="Agent wallet" value={shorten(agent, 5, 5)} state={port(signature)} delay={ARRIVE_MS} />
        <Beam index="02" label={agentId ? `owner · #${agentId}` : 'owner'} state={identity} delay={ARRIVE_MS + 100} />
        <Port Glyph={OwnerGlyph} label="Owner wallet" value={owner ? shorten(owner, 5, 5) : '—'} state={port(identity)} delay={2 * ARRIVE_MS + 100} />
      </div>
    </div>
  );
}

function Port({
  Glyph,
  label,
  value,
  state,
  delay,
}: {
  Glyph: (p: { className?: string }) => React.ReactNode;
  label: string;
  value: string;
  state: PortState;
  delay: number;
}) {
  const text = state === 'fail' ? 'text-danger' : state === 'true' ? 'text-fg' : 'text-fg-3';
  // Lights on arrival; goes dark at once when a new run resets it.
  const lit = { transitionDelay: state === 'idle' ? '0ms' : `${delay}ms` };
  return (
    <div className="flex shrink-0 items-center gap-4 md:w-32 md:flex-col md:gap-0 md:text-center">
      <div className="port port-sm" data-on={state} style={lit}>
        <Glyph className="draw h-[18px] w-[18px]" />
      </div>
      <div className="md:mt-3">
        <div className="text-[13px] text-fg-2">{label}</div>
        <div className={`mt-0.5 font-mono text-[12px] transition-colors duration-300 ${text}`} style={lit}>
          {value}
        </div>
      </div>
    </div>
  );
}

function Beam({ index, label, state, delay }: { index: string; label: string; state: CheckState; delay: number }) {
  const text = state === 'fail' ? 'text-danger' : state === 'pass' ? 'text-fg' : 'text-fg-3';
  const drawn = state === 'pass' || state === 'fail';
  return (
    <div className="beam relative ml-5 h-12 md:mt-5 md:ml-0 md:h-auto md:flex-1" data-state={state}>
      <div className="beam-line absolute top-0 left-0 h-full w-px md:h-px md:w-full" aria-hidden />
      <div className="beam-fill absolute top-0 left-0 h-full w-px md:h-px md:w-full" style={{ transitionDelay: drawn ? `${delay}ms` : '0ms' }} aria-hidden />
      <span
        className={`absolute top-1/2 left-5 -translate-y-1/2 font-mono text-[11px] whitespace-nowrap transition-colors duration-300 md:top-auto md:bottom-2 md:left-1/2 md:-translate-x-1/2 md:translate-y-0 ${text}`}
        style={{ transitionDelay: drawn ? `${delay + 200}ms` : '0ms' }}
      >
        {index} {state === 'fail' ? 'broken ×' : state === 'pass' ? `${label} ✓` : label}
      </span>
    </div>
  );
}
