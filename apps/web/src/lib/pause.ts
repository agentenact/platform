/** The pause button's state change as plain data. The server's answer decides; nothing is shown ahead of it. */
import { copy } from '@/copy';

export interface PauseState {
  paused: boolean;
  busy: boolean;
  message: string | null;
}

export type RunPause = (wantPaused: boolean) => Promise<{ ok: boolean; status?: number }>;

/** Asks for the opposite state. The returned state flips `paused` only if the server said ok. Never throws. */
export async function runPause(s: PauseState, run: RunPause): Promise<PauseState> {
  const want = !s.paused;
  let out: { ok: boolean; status?: number } = { ok: false };
  try {
    out = await run(want);
  } catch {
    out = { ok: false };
  }
  if (out.ok) return { paused: want, busy: false, message: null };
  // A resume the api refuses with 409 is an agent still getting ready (awaiting_funds; a page drawn before the flag, or an
  // older api): it starts on its own, so the line says that instead of "try again".
  const message = want ? copy.agent.pauseFailed : out.status === 409 ? copy.agent.resumeGettingReady : copy.agent.resumeFailed;
  return { paused: s.paused, busy: false, message };
}
