/** The plain line for one step of a run, from the tools it used. Shared by the trial result and the run details. */
const WORDS = new Map<string, string>(Object.entries({
  stellar_price: 'Read the price',
  stellar_price_change: 'Read the price',
  market_price: 'Read the price',
  stellar_read: 'Looked up an account',
  stellar_payments: 'Read recent payments',
  wallet_payments: 'Read recent payments',
  wallet_balance: 'Looked up a wallet',
  web_search: 'Searched the web',
  web_read: 'Read a web page',
  compute: 'Worked something out',
  send_email: 'Emailed you',
  send_webhook: 'Called your webhook',
  hire_agent: 'Paid another agent for help',
  find_agents: 'Looked for other agents',
  get_agent: 'Looked up another agent',
  verify_record: 'Checked another agent’s proof',
  remember: 'Made a note for next time',
}));
const TRIAL_WORDS = new Map([['send_email', "Wrote the email I'd send"]]);
const NONE = 'Thought it over';

/** "Read the price", "Searched the web, then read a web page". In a trial nothing is sent, so an email is only written. */
export function stepWords(tools: readonly string[], opts: { trial?: boolean } = {}): string {
  const lines: string[] = [];
  for (const t of tools) {
    const w = (opts.trial ? TRIAL_WORDS.get(t) : undefined) ?? WORDS.get(t);
    if (w && !lines.includes(w)) lines.push(w);
  }
  if (lines.length === 0) return NONE;
  return lines.map((w, i) => (i === 0 ? w : w.charAt(0).toLowerCase() + w.slice(1))).join(', then ');
}

const DOING = new Map<string, string>(Object.entries({
  stellar_price: 'Reading the price',
  stellar_price_change: 'Reading the price',
  market_price: 'Reading the price',
  stellar_read: 'Looking up an account',
  stellar_payments: 'Reading recent payments',
  wallet_payments: 'Reading recent payments',
  wallet_balance: 'Looking up a wallet',
  web_search: 'Searching the web',
  web_read: 'Reading a web page',
  compute: 'Working something out',
  send_email: 'Emailing you',
  send_webhook: 'Calling your webhook',
  hire_agent: 'Paying another agent for help',
  find_agents: 'Looking for other agents',
  get_agent: 'Looking up another agent',
  verify_record: 'Checking another agent’s proof',
  remember: 'Making a note for next time',
}));

/** The words for a tool call while it runs. */
export const doingWords = (tool: string): string => DOING.get(tool) ?? 'Working on it';
