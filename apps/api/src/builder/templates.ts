/**
 * Agent templates: ready drafts a visitor can open without a model call. Each is one of the Builder's validated
 * examples (examples.ts, one copy), so a template is the same DraftResult the Builder would answer and goes through the
 * same params, trial, handoff and create steps. Opening one costs no tokens and counts against no limit.
 */
import type { DraftResult } from './draft-schema.js';
import { agentEconomy, bigMove, bigUsdc, bigUsdt, btcRange, btcReceived, coinCrash, coinJump, dailyBalance, dailyDigest, lowBalance, lowUsdc, marketMorning, moneyOut, morningPrices, paymentReceived, priceTarget, quietWallet, stablecoinPeg, stablecoinReceived, usdcPeg, watchAccount, weeklyRecap, xlmDrop } from './examples.js';

export const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentTemplate {
  id: string;
  title: string;
  /** One line for a picker. */
  summary: string;
  draft: DraftResult;
}

const list: { id: string; title: string; summary: string; draft: () => DraftResult }[] = [
  { id: 'xlm-drop', title: 'XLM buy-the-dip alert', summary: 'Emails you when XLM dips sharply in an hour, a chance to buy.', draft: xlmDrop },
  { id: 'wallet-watch', title: 'Wallet watcher', summary: 'Emails you when a wallet sends or receives money.', draft: watchAccount },
  { id: 'big-usdc', title: 'Big USDC moves', summary: 'Emails you when a wallet moves a large amount of USDC.', draft: bigUsdc },
  { id: 'daily-digest', title: 'Daily Stellar digest', summary: 'Writes a short Stellar DeFi digest every day.', draft: dailyDigest },
  { id: 'coin-crash', title: 'Bargain alert', summary: 'Emails you when BTC, ETH, SOL or XLM gets much cheaper in a day.', draft: coinCrash },
  { id: 'coin-jump', title: 'Price jump alert', summary: 'Emails you when a coin rises sharply in an hour.', draft: coinJump },
  { id: 'price-target', title: 'XLM price target', summary: 'Emails you once XLM reaches the price you pick.', draft: priceTarget },
  { id: 'usdc-peg', title: 'USDC dollar check', summary: 'Emails you if USDC stops holding a dollar.', draft: usdcPeg },
  { id: 'payment-received', title: 'Payment received', summary: 'Emails you when money arrives in a wallet.', draft: paymentReceived },
  { id: 'low-balance', title: 'Top-up reminder', summary: 'Reminds you to top up a wallet before its XLM runs low.', draft: lowBalance },
  { id: 'money-out', title: 'Spending tracker', summary: 'Emails you each time a wallet sends money, so you always know where it went.', draft: moneyOut },
  { id: 'low-usdc', title: 'USDC top-up reminder', summary: 'Reminds you to top up a wallet before its USDC runs low.', draft: lowUsdc },
  { id: 'big-usdt', title: 'Big USDT moves', summary: 'Emails you when a wallet moves a large amount of USDT.', draft: bigUsdt },
  { id: 'daily-balance', title: 'Daily balance', summary: 'Emails you what a wallet holds, every day.', draft: dailyBalance },
  { id: 'stablecoin-received', title: 'Stablecoin received', summary: 'Emails you when USDC or USDT arrives, on Ethereum, Base, Solana and more.', draft: stablecoinReceived },
  { id: 'btc-received', title: 'Bitcoin payment confirmed', summary: 'Emails you once a Bitcoin payment to you is confirmed.', draft: btcReceived },
  { id: 'quiet-wallet', title: 'Daily sales check-in', summary: 'Checks a wallet gets paid every day and lets you know on a day it does not.', draft: quietWallet },
  { id: 'stablecoin-peg', title: 'Dollar coins check', summary: 'Emails you if USDT, DAI or another dollar coin stops holding a dollar.', draft: stablecoinPeg },
  { id: 'morning-prices', title: 'Morning prices', summary: 'Emails you XLM, BTC and ETH prices every day.', draft: morningPrices },
  { id: 'weekly-recap', title: 'Weekly crypto recap', summary: 'Writes a short recap of the crypto week.', draft: weeklyRecap },
  { id: 'btc-range', title: 'BTC range alert', summary: 'Emails you when BTC leaves the price range you set.', draft: btcRange },
  { id: 'big-move', title: 'Big move alert', summary: 'Emails you when a coin moves sharply in an hour, up or down.', draft: bigMove },
  { id: 'market-morning', title: 'Market morning', summary: 'Emails you prices and the day’s top crypto headline.', draft: marketMorning },
  { id: 'agent-economy', title: 'Agent economy weekly', summary: 'Writes a weekly brief on AI agents that pay and get paid.', draft: agentEconomy },
];

/** Every template, each draft built (and so checked) at call time. */
export const agentTemplates = (): AgentTemplate[] => list.map((t) => ({ id: t.id, title: t.title, summary: t.summary, draft: t.draft() }));
