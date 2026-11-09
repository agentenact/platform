/** Ends this device's session only (other devices and the account key flow stay signed in), then goes to the first screen. */
export function createSignOut(d: { client(): Promise<{ auth: { signOut(o: { scope: 'local' }): Promise<unknown> } }>; redirect(to: string): never }) {
  return async (): Promise<void> => {
    await (await d.client()).auth.signOut({ scope: 'local' });
    d.redirect('/');
  };
}
