/**
 * What the /create builder shows about each ready agent beyond its draft: its group for the filter, how often it checks,
 * what it reads, and an example of the email it sends. The email is illustrative (labelled as an example on the page); its
 * numbers are made up. Keyed by the api's template ids; tests/create-builder.test.tsx fails if one is missing or stale.
 */
export interface TemplateFacts {
  group: 'Prices' | 'Wallets' | 'Daily notes';
  checks: string;
  reads: string;
  /** Which chain it reads, in plain words: the answer to "is this for Stellar?". */
  network: string;
  email: { subject: string; body: string };
}

export const TEMPLATE_FACTS: Readonly<Record<string, TemplateFacts>> = {
  "xlm-drop": { group: "Prices", checks: "Every 5 min", reads: "XLM price", network: "Market price, any exchange", email: { subject: "XLM is 6.2% cheaper than an hour ago", body: "XLM is at $0.312, from $0.333 an hour ago. A dip, if you were waiting to buy." } },
  "coin-crash": { group: "Prices", checks: "Every 15 min", reads: "Coin price", network: "Market price, any exchange", email: { subject: "BTC is 11% cheaper than yesterday", body: "BTC is at $88,400, from $99,300 a day ago." } },
  "coin-jump": { group: "Prices", checks: "Every 5 min", reads: "Coin price", network: "Market price, any exchange", email: { subject: "ETH rose 5.4% in the last hour", body: "ETH is at $3,920, up from $3,719 an hour ago." } },
  "price-target": { group: "Prices", checks: "Every 5 min", reads: "XLM price", network: "Market price, any exchange", email: { subject: "XLM reached $1", body: "XLM is trading at $1.004 right now." } },
  "usdc-peg": { group: "Prices", checks: "Every 5 min", reads: "USDC price", network: "Market price, any exchange", email: { subject: "USDC is below a dollar", body: "USDC is trading at $0.987. It was $0.999 an hour ago." } },
  "btc-range": { group: "Prices", checks: "Every 5 min", reads: "BTC price", network: "Market price, any exchange", email: { subject: "BTC broke above your range", body: "BTC is at $90,640, above the $90,000 you set." } },
  "big-move": { group: "Prices", checks: "Every 5 min", reads: "Hourly change", network: "Market price, any exchange", email: { subject: "SOL moved 5.2% in an hour", body: "SOL rose from $172.90 to $181.90 in the last hour." } },
  "stablecoin-peg": { group: "Prices", checks: "Every 5 min", reads: "Dollar coin prices", network: "Market price, any exchange", email: { subject: "USDT drifted from a dollar", body: "USDT is trading at $0.982. DAI, USDe, PYUSD and FDUSD are at a dollar." } },
  "wallet-watch": { group: "Wallets", checks: "Every 5 min", reads: "Wallet payments", network: "Stellar, Ethereum, Base, Solana, Bitcoin and more", email: { subject: "Your wallet moved money", body: "GBX4…7QLM sent 250 XLM to GCA2…P3TE." } },
  "payment-received": { group: "Wallets", checks: "Every 5 min", reads: "Wallet payments", network: "Stellar, Ethereum, Base, Solana, Bitcoin and more", email: { subject: "You received 40 USDC", body: "GCA2…P3TE paid your wallet 40 USDC." } },
  "big-usdc": { group: "Wallets", checks: "Every 5 min", reads: "Wallet payments", network: "Stellar, Ethereum, Base, Solana and more", email: { subject: "A big USDC move", body: "Your wallet sent 25,000 USDC to GDQ5…M2RA." } },
  "low-balance": { group: "Wallets", checks: "Every hour", reads: "Wallet balance", network: "Stellar, Ethereum, Base, Solana, Bitcoin and more", email: { subject: "Time to top up your XLM", body: "It holds 62.4 XLM, below your 100 XLM line." } },
  "money-out": { group: "Wallets", checks: "Every 5 min", reads: "Outgoing payments", network: "Stellar, Ethereum, Base, Solana, Bitcoin and more (Ethereum-type networks: USDC and USDT)", email: { subject: "You sent 250 USDC", body: "Your wallet sent 250 USDC to 0x4cfc…23e6. If that was you, nothing to do." } },
  "low-usdc": { group: "Wallets", checks: "Every hour", reads: "Wallet balance", network: "Stellar, Ethereum, Base, Solana and more", email: { subject: "Time to top up your USDC", body: "It holds 62.4 USDC, below your 100 USDC line." } },
  "big-usdt": { group: "Wallets", checks: "Every 5 min", reads: "Wallet payments", network: "Ethereum, Base, Solana and more (no Stellar)", email: { subject: "A big USDT move", body: "Your wallet received 25,000 USDT from 0x4cfc…23e6." } },
  "daily-balance": { group: "Wallets", checks: "Once a day", reads: "Wallet balance", network: "Stellar, Ethereum, Base, Solana, Bitcoin and more", email: { subject: "What your wallet holds today", body: "1,204 XLM and 380 USDC on Stellar." } },
  "stablecoin-received": { group: "Wallets", checks: "Every 5 min", reads: "USDC and USDT payments", network: "Ethereum, Base, Arbitrum, Optimism, Polygon, Celo, Solana", email: { subject: "You received 250 USDC on Base", body: "0x7a3f…91c2 paid your wallet 250 USDC." } },
  "btc-received": { group: "Wallets", checks: "Every 10 min", reads: "Confirmed payments", network: "Bitcoin", email: { subject: "0.0042 BTC arrived", body: "A payment of 0.0042 BTC to your address is confirmed." } },
  "quiet-wallet": { group: "Wallets", checks: "Every 6 hours", reads: "Wallet payments", network: "Stellar, Solana, Bitcoin", email: { subject: "A quiet day for your wallet", body: "No payment has arrived in the last 24 hours. Worth a look at your shop or checkout." } },
  "daily-digest": { group: "Daily notes", checks: "Once a day", reads: "News and prices", network: "Stellar", email: { subject: "Stellar DeFi, this morning", body: "Three things moved overnight: …" } },
  "morning-prices": { group: "Daily notes", checks: "Once a day", reads: "Prices", network: "Web and market prices", email: { subject: "Prices this morning", body: "XLM $0.31 (−1.2%) · BTC $97,800 (+0.8%) · ETH $3,840 (+2.1%)" } },
  "weekly-recap": { group: "Daily notes", checks: "Once a week", reads: "News and prices", network: "Web and market prices", email: { subject: "Your crypto week", body: "The biggest move this week was …" } },
  "market-morning": { group: "Daily notes", checks: "Once a day", reads: "Prices and news", network: "Web and market prices", email: { subject: "Your market morning", body: "BTC $80,500 (+0.6%), ETH … Today’s headline: …" } },
  "agent-economy": { group: "Daily notes", checks: "Once a week", reads: "News", network: "Web and market prices", email: { subject: "The agent economy this week", body: "Five things that happened, each with its source: …" } },
};

/** The filter's groups, in the order the page shows them. */
export const TEMPLATE_GROUPS = ['Prices', 'Wallets', 'Daily notes'] as const;

/** An agent that is planned but cannot be created yet: listed under its kind with a "Soon" badge. */
export interface SoonAgent {
  id: string;
  title: string;
  summary: string;
}

/**
 * Kinds of agent that are coming but have no ready agent yet. The filter shows each after the live groups with a "Soon"
 * badge. A kind that lists its coming agents can be opened to see them; none of them can be picked. A kind moves to
 * TEMPLATE_GROUPS when its first ready agent ships.
 */
export const SOON_GROUPS: readonly { name: string; note: string; agents?: readonly SoonAgent[] }[] = [
  {
    name: 'Trade',
    note: 'Buys and sells within the limits you set.',
    agents: [
      { id: 'soon-arbitrage', title: 'Arbitrage Agent', summary: 'Buys where an asset is cheaper and sells where it is dearer.' },
      { id: 'soon-yield', title: 'Yield Agent', summary: 'Keeps idle stablecoins where they earn the most, within your limits.' },
      { id: 'soon-lp-rebalancer', title: 'LP Rebalancer Agent', summary: 'Keeps a liquidity position in range as prices move.' },
      { id: 'soon-volume', title: 'Volume Agent', summary: 'Splits a large buy or sell into small orders over time.' },
      { id: 'soon-trade', title: 'Trade Agent', summary: 'Buys and sells on the rules you set, under a spending cap.' },
      { id: 'soon-market-maker', title: 'Market Maker Agent', summary: 'Quotes both sides of a market and earns the spread.' },
    ],
  },
  { name: 'Travel', note: 'Finds flights and hotels that fit your dates and budget.' },
  { name: 'Sell', note: 'Answers paid requests from other agents.' },
  { name: 'Hire', note: 'Pays other agents to do part of a task.' },
  { name: 'Research', note: 'Gathers sources and writes up what it found.' },
];
