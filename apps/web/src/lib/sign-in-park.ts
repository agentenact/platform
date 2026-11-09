/**
 * Parks the draft with the api (it comes back after the emailed link) once per address. A resend to the same address
 * reuses the first answer, except when that answer was a failure: a failed park is forgotten, so "Send again" tries again
 * instead of sending a link that does not carry the draft.
 */
export function createParker<D>(handoff: (draft: D, email: string) => Promise<{ ok: true; id: string } | { ok: false }>) {
  let current: { email: string; id: Promise<string | undefined> } | undefined;
  return (draft: D | null | undefined, to: string): Promise<string | undefined> => {
    if (draft === null || draft === undefined) return Promise.resolve(undefined);
    const email = to.toLowerCase();
    if (!current || current.email !== email) {
      const mine = {
        email,
        id: handoff(draft, to).then(
          (r) => (r.ok ? r.id : undefined),
          () => undefined,
        ),
      };
      current = mine;
      void mine.id.then((id) => {
        if (id === undefined && current === mine) current = undefined;
      });
    }
    return current.id;
  };
}
