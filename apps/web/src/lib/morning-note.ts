/** The morning note question's state change as plain data. The server's answer decides; nothing is shown ahead of it. */
import { copy } from '@/copy';

export interface MorningNoteState {
  /** null = not answered yet. */
  answer: boolean | null;
  busy: boolean;
  message: string | null;
}

export type SaveMorningNote = (on: boolean) => Promise<{ ok: boolean }>;

/** Asks the server to store `want`. The returned state takes the answer only if the server said ok. Never throws. */
export async function runMorningNote(s: MorningNoteState, want: boolean, save: SaveMorningNote): Promise<MorningNoteState> {
  let ok = false;
  try {
    ok = (await save(want)).ok;
  } catch {
    ok = false;
  }
  return ok ? { answer: want, busy: false, message: null } : { answer: s.answer, busy: false, message: copy.morningNote.failed };
}
