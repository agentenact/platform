/** What opening a wallet answers: the new list, or a plain sentence. */
export type OpenWalletOut = { ok: true; wallets: AgentWallet[] } | { ok: false; message: string };

/** The agent's wallets as the api lists them (GET /api/agents/:id/wallets). Anything malformed is dropped, never shown. */
export interface AgentWallet {
  network: string;
  label: string;
  address: string | null;
  usdc: string | null;
  /** What it holds, the native coin first; null when unknown (never shown as a zero). */
  assets: WalletAsset[] | null;
  explorer: string | null;
  /** Stellar only: who holds the setup deposit (the account's reserves). Absent when the api does not say. */
  reserve?: 'free' | 'due' | 'self_paid';
}

export interface WalletAsset {
  symbol: string;
  amount: string;
}

const ADDRESS = /^(G[A-Z2-7]{55}|0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const AMOUNT = /^\d{1,15}(\.\d{1,8})?$/;
const SYMBOL = /^[A-Z]{2,6}$/;
const EXPLORER = /^https:\/\/(stellar\.expert|sepolia\.basescan\.org|sepolia\.arbiscan\.io|testnet\.snowtrace\.io|amoy\.polygonscan\.com|explorer\.solana\.com)\//;

export function asWallets(json: unknown): AgentWallet[] | null {
  const list = (json as { wallets?: unknown } | null)?.wallets;
  if (!Array.isArray(list)) return null;
  const out: AgentWallet[] = [];
  for (const w of list) {
    if (!w || typeof w !== 'object') continue;
    const { network, label, address, usdc, assets, explorer, reserve } = w as Record<string, unknown>;
    if (typeof network !== 'string' || !/^(stellar:testnet|eip155:\d{1,12}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/.test(network) || typeof label !== 'string' || label.length > 40) continue;
    const addr = typeof address === 'string' && ADDRESS.test(address) ? address : null;
    out.push({
      network,
      label,
      address: addr,
      usdc: addr && typeof usdc === 'string' && AMOUNT.test(usdc) ? trimAmount(usdc) : null,
      assets: addr ? asAssets(assets) : null,
      explorer: addr && typeof explorer === 'string' && EXPLORER.test(explorer) ? explorer : null,
      ...(addr && (reserve === 'free' || reserve === 'due' || reserve === 'self_paid') ? { reserve } : {}),
    });
  }
  return out;
}

/** Up to eight well-formed holdings; one malformed entry makes the whole list unknown rather than partly shown. */
function asAssets(json: unknown): WalletAsset[] | null {
  if (!Array.isArray(json) || json.length > 8) return null;
  const out: WalletAsset[] = [];
  for (const a of json) {
    const { symbol, amount } = (a ?? {}) as Record<string, unknown>;
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol) || typeof amount !== 'string' || !AMOUNT.test(amount)) return null;
    out.push({ symbol, amount: trimAmount(amount) });
  }
  return out;
}

/** "2.5000000" → "2.50": two places at least, no trailing zeros past them. */
export function trimAmount(a: string): string {
  const [i, f = ''] = a.split('.');
  const frac = f.replace(/0+$/, '').padEnd(2, '0');
  return `${i}.${frac}`;
}

/** "GABC…WXYZ", "0x1234…abcd". */
export const shortWallet = (a: string): string => (a.startsWith('0x') ? `${a.slice(0, 6)}…${a.slice(-4)}` : `${a.slice(0, 4)}…${a.slice(-4)}`);
