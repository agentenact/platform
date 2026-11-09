import { parseSpec } from '../specs/schema.js';
import { checkDraft, DraftResult } from './draft-schema.js';

/**
 * The four DefiUser examples as validated drafts. The Builder's prompt shows them to the model, and tests import them
 * from here (one copy). Each is built and checked at call time, so a bad edit throws at once. The condition ones
 * set `params` only when they have a tunable: an empty `params` is never emitted ({} and absent give different trigger keys).
 */
export const SAMPLE_ACCOUNT = `G${'A'.repeat(55)}`;

function build(raw: unknown): DraftResult {
  const d = DraftResult.parse(raw);
  const s = parseSpec(d.spec);
  if (!s.ok) throw new Error(`drafts fixture: ${s.problem}`);
  const out = { ...d, spec: s.spec };
  const problem = checkDraft(out);
  if (problem) throw new Error(`drafts fixture: ${problem}`);
  return out;
}

const base = { persona: 'A calm Stellar watcher.', system_prompt: 'Watch and report in plain words.' };
const wallet = { persona: 'A calm wallet watcher.', system_prompt: 'Watch and report in plain words.' };

/** The networks a wallet template offers (a choice holds at most 8). The tools read more: Optimism and the testnets. */
export const CHAIN_OPTIONS = [
  { label: 'Stellar', value: 'stellar' },
  { label: 'Ethereum', value: 'ethereum' },
  { label: 'Base', value: 'base' },
  { label: 'Arbitrum', value: 'arbitrum' },
  { label: 'Polygon', value: 'polygon' },
  { label: 'Celo', value: 'celo' },
  { label: 'Solana', value: 'solana' },
  { label: 'Bitcoin', value: 'bitcoin' },
];
/** Bitcoin holds no USDC; Optimism takes its place. */
const USDC_CHAIN_OPTIONS = [...CHAIN_OPTIONS.filter((o) => o.value !== 'bitcoin'), { label: 'Optimism', value: 'optimism' }];

/** "tell me when XLM drops 5% in an hour". */
export const xlmDrop = () =>
  build({
    name: 'XLM buy-the-dip alert',
    sentence: ['Every 5 minutes I look at XLM and email you when it is ', { param: 'drop' }, '% or more cheaper than an hour ago, a chance to buy. Otherwise I stay quiet and spend nothing.'],
    params: [{ id: 'drop', label: 'Dip', kind: 'number', value: 5, min: 1, max: 50, unit: '%' }],
    bindings: [{ param: 'drop', path: '/triggers/0/params/drop_pct' }],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price_change', args: { symbol: 'XLM', window_s: 3600 } },
          code: 'return !input.stale && input.changePct <= -params.drop_pct;',
          params: { drop_pct: 5 },
          every_s: 300,
          cooldown_s: 3600,
          mission: 'XLM is sharply cheaper than an hour ago. Tell the owner briefly and calmly, as a chance to buy.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "watch this wallet". */
export const watchAccount = () =>
  build({
    name: 'Account watcher',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if it receives or sends money. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: CHAIN_OPTIONS, value: 'stellar' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'stellar', address: SAMPLE_ACCOUNT, direction: 'both', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'The watched account moved money. Say who paid whom and how much.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "alert me on a big USDC move". */
export const bigUsdc = () =>
  build({
    name: 'Big USDC move',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if it moves ', { param: 'size' }, ' or more. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: USDC_CHAIN_OPTIONS, value: 'stellar' },
      {
        id: 'size',
        label: 'Size',
        kind: 'choice',
        options: [
          { label: '1,000 USDC', value: '1000' },
          { label: '10,000 USDC', value: '10000' },
          { label: '100,000 USDC', value: '100000' },
        ],
        value: '10000',
      },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'size', path: '/triggers/0/fetch/args/min_amount' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'stellar', address: SAMPLE_ACCOUNT, asset: 'USDC', min_amount: '10000', direction: 'both', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'A large USDC payment happened. Say who paid whom and how much.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "daily Stellar DeFi digest". */
export const dailyDigest = () =>
  build({
    name: 'Daily Stellar digest',
    sentence: ['Every ', { param: 'when' }, ' I write a short Stellar DeFi digest and email it to you.'],
    params: [
      {
        id: 'when',
        label: 'When',
        kind: 'time',
        presets: [
          { label: 'morning', value: '0 8 * * *' },
          { label: 'evening', value: '0 18 * * *' },
        ],
        value: '0 8 * * *',
      },
    ],
    bindings: [{ param: 'when', path: '/triggers/0/cron' }],
    spec: {
      ...base,
      tools: ['web_search', 'web_read', 'market_price', 'send_email'],
      triggers: [{ kind: 'cron', cron: '0 8 * * *', mission: 'Write a short digest of what happened in Stellar DeFi in the last day and email it.' }],
      delivery: { email: true },
    },
  });

/*
 * Template-only drafts: ready agents a visitor opens from the picker. They are not shown to the Builder's model
 * (EXAMPLES below stays the four), so adding one never changes what the Builder writes.
 */

const COINS = [
  { label: 'BTC', value: 'BTC' },
  { label: 'ETH', value: 'ETH' },
  { label: 'SOL', value: 'SOL' },
  { label: 'XLM', value: 'XLM' },
];

/** "tell me if BTC crashes today". */
export const coinCrash = () =>
  build({
    name: 'Bargain alert',
    sentence: ['Every 15 minutes I look at ', { param: 'coin' }, ' and email you when it is ', { param: 'drop' }, '% or more cheaper than a day ago, a chance to buy. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'coin', label: 'Coin', kind: 'choice', options: COINS, value: 'BTC' },
      { id: 'drop', label: 'Dip', kind: 'number', value: 10, min: 2, max: 60, unit: '%' },
    ],
    bindings: [
      { param: 'coin', path: '/triggers/0/fetch/args/symbol' },
      { param: 'drop', path: '/triggers/0/params/drop_pct' },
    ],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price_change', args: { symbol: 'BTC', window_s: 86_400 } },
          code: 'return !input.stale && input.changePct <= -params.drop_pct;',
          params: { drop_pct: 10 },
          every_s: 900,
          cooldown_s: 86_400,
          mission: 'The coin is sharply cheaper than a day ago. Tell the owner briefly and calmly, as a chance to buy, with the price now and a day ago.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me when ETH jumps". */
export const coinJump = () =>
  build({
    name: 'Price jump alert',
    sentence: ['Every 5 minutes I look at ', { param: 'coin' }, ' and email you if it rises ', { param: 'rise' }, '% or more in an hour. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'coin', label: 'Coin', kind: 'choice', options: COINS, value: 'ETH' },
      { id: 'rise', label: 'Rise', kind: 'number', value: 5, min: 1, max: 50, unit: '%' },
    ],
    bindings: [
      { param: 'coin', path: '/triggers/0/fetch/args/symbol' },
      { param: 'rise', path: '/triggers/0/params/rise_pct' },
    ],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price_change', args: { symbol: 'ETH', window_s: 3600 } },
          code: 'return !input.stale && input.changePct >= params.rise_pct;',
          params: { rise_pct: 5 },
          every_s: 300,
          cooldown_s: 3600,
          mission: 'The coin rose sharply in the last hour. Tell the owner briefly, with the price now and an hour ago.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me when XLM reaches a dollar". */
export const priceTarget = () =>
  build({
    name: 'XLM price target',
    sentence: ['Every 5 minutes I check the XLM price and email you once it reaches $', { param: 'target' }, '. Otherwise I stay quiet and spend nothing.'],
    params: [{ id: 'target', label: 'Target', kind: 'number', value: 1, min: 0.01, max: 100 }],
    bindings: [{ param: 'target', path: '/triggers/0/params/target' }],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price', args: { symbol: 'XLM' } },
          code: 'return !input.stale && Number(input.usd) >= params.target;',
          params: { target: 1 },
          every_s: 300,
          cooldown_s: 86_400,
          mission: 'XLM reached the price the owner was waiting for. Tell them briefly, with the price now.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "warn me if USDC loses its dollar peg". */
export const usdcPeg = () =>
  build({
    name: 'USDC dollar check',
    sentence: ['Every 5 minutes I check that USDC is worth a dollar and email you if it trades below $', { param: 'floor' }, '. Otherwise I stay quiet and spend nothing.'],
    params: [{ id: 'floor', label: 'Floor', kind: 'number', value: 0.99, min: 0.5, max: 0.999 }],
    bindings: [{ param: 'floor', path: '/triggers/0/params/floor' }],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price', args: { symbol: 'USDC' } },
          code: 'return !input.stale && Number(input.usd) < params.floor;',
          params: { floor: 0.99 },
          every_s: 300,
          cooldown_s: 3600,
          mission: 'USDC is trading below a dollar. Tell the owner calmly, with the price now.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me when I get paid". */
export const paymentReceived = () =>
  build({
    name: 'Payment received',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you when money arrives. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: CHAIN_OPTIONS, value: 'stellar' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'stellar', address: SAMPLE_ACCOUNT, direction: 'in', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'The wallet received money. Say who paid and how much.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "warn me before my wallet runs dry". The minimum is in the network's own coin (XLM, ETH, SOL, BTC ...). */
export const lowBalance = () =>
  build({
    name: 'Top-up reminder',
    sentence: ['Every hour I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if it holds less than ', { param: 'min' }, ' of that network’s own coin. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: CHAIN_OPTIONS, value: 'stellar' },
      { id: 'min', label: 'Minimum', kind: 'number', value: 100, min: 0.0001, max: 1_000_000 },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'min', path: '/triggers/0/params/min_balance' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_balance', args: { chain: 'stellar', address: SAMPLE_ACCOUNT } },
          code: 'if (!input.exists) return false; const coin = input.balances[0]; return !!coin && Number(coin.amount) < params.min_balance;',
          params: { min_balance: 100 },
          every_s: 3600,
          cooldown_s: 86_400,
          mission: 'The wallet is running low on its network’s own coin. Tell the owner the balance now.',
        },
      ],
      delivery: { email: true },
    },
  });

/** A placeholder EVM wallet, for templates that start on an EVM network (the Stellar sample fits no other chain). */
const SAMPLE_EVM_ACCOUNT = `0x${'ab'.repeat(20)}`;
/** USDT exists on EVM chains and Solana, not on Stellar or Bitcoin. */
const USDT_CHAIN_OPTIONS = USDC_CHAIN_OPTIONS.filter((o) => o.value !== 'stellar');

/** "tell me if money leaves my wallet". A tripwire: it reads outgoing payments only. */
export const moneyOut = () =>
  build({
    name: 'Spending tracker',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you each time it sends money. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: CHAIN_OPTIONS, value: 'stellar' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'stellar', address: SAMPLE_ACCOUNT, direction: 'out', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'The watched wallet sent money. Say where it went and how much, in one or two lines, so the owner can confirm it was them.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "alert me on a big USDT move". USDT lives on EVM chains and Solana. */
export const bigUsdt = () =>
  build({
    name: 'Big USDT move',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if it moves ', { param: 'size' }, ' or more. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_EVM_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: USDT_CHAIN_OPTIONS, value: 'ethereum' },
      {
        id: 'size',
        label: 'Size',
        kind: 'choice',
        options: [
          { label: '1,000 USDT', value: '1000' },
          { label: '10,000 USDT', value: '10000' },
          { label: '100,000 USDT', value: '100000' },
        ],
        value: '10000',
      },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'size', path: '/triggers/0/fetch/args/min_amount' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'ethereum', address: SAMPLE_EVM_ACCOUNT, asset: 'USDT', min_amount: '10000', direction: 'both', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'A large USDT payment happened. Say who paid whom and how much.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "warn me before my wallet runs out of USDC". The read lists only what a wallet holds, so no USDC row means none. */
export const lowUsdc = () =>
  build({
    name: 'USDC top-up reminder',
    sentence: ['Every hour I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if it holds less than ', { param: 'min' }, ' USDC. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: USDC_CHAIN_OPTIONS, value: 'stellar' },
      { id: 'min', label: 'Minimum', kind: 'number', value: 100, min: 1, max: 1_000_000, unit: 'USDC' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'min', path: '/triggers/0/params/min_usdc' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_balance', args: { chain: 'stellar', address: SAMPLE_ACCOUNT } },
          code: "if (!input.exists) return false; const usdc = input.balances.find((b) => b.symbol === 'USDC'); return (usdc ? Number(usdc.amount) : 0) < params.min_usdc;",
          params: { min_usdc: 100 },
          every_s: 3600,
          cooldown_s: 86_400,
          mission: 'It is time to top up the wallet’s USDC. Tell the owner how much USDC it holds now.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me what my wallet holds every day". The condition is always true for a wallet the chain has seen; the cooldown makes it daily. */
export const dailyBalance = () =>
  build({
    name: 'Daily balance',
    sentence: ['Every day I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you what it holds.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: CHAIN_OPTIONS, value: 'stellar' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_balance', args: { chain: 'stellar', address: SAMPLE_ACCOUNT } },
          code: 'return input.exists;',
          every_s: 86_400,
          cooldown_s: 86_400,
          mission: 'Email the owner a short note of what the wallet holds right now: the network’s own coin first, then any USDC or USDT.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "email me the prices every morning". */
export const morningPrices = () =>
  build({
    name: 'Morning prices',
    sentence: ['Every ', { param: 'when' }, ' I email you the prices of XLM, BTC and ETH and how much each moved in the last day.'],
    params: [
      {
        id: 'when',
        label: 'When',
        kind: 'time',
        presets: [
          { label: 'morning', value: '0 7 * * *' },
          { label: 'evening', value: '0 19 * * *' },
        ],
        value: '0 7 * * *',
      },
    ],
    bindings: [{ param: 'when', path: '/triggers/0/cron' }],
    spec: {
      ...base,
      tools: ['stellar_price', 'stellar_price_change', 'send_email'],
      triggers: [{ kind: 'cron', cron: '0 7 * * *', mission: 'Read the prices of XLM, BTC and ETH and their change over the last day, then email a short note with all three.' }],
      delivery: { email: true },
    },
  });

/** "a weekly crypto recap". */
export const weeklyRecap = () =>
  build({
    name: 'Weekly crypto recap',
    sentence: ['Every ', { param: 'when' }, ' I write a short recap of the crypto week and email it to you.'],
    params: [
      {
        id: 'when',
        label: 'When',
        kind: 'time',
        presets: [
          { label: 'Monday morning', value: '0 8 * * 1' },
          { label: 'Friday evening', value: '0 18 * * 5' },
        ],
        value: '0 8 * * 1',
      },
    ],
    bindings: [{ param: 'when', path: '/triggers/0/cron' }],
    spec: {
      ...base,
      tools: ['web_search', 'web_read', 'market_price', 'send_email'],
      triggers: [{ kind: 'cron', cron: '0 8 * * 1', mission: 'Write a short recap of the past week in crypto: the biggest price moves and the news behind them. Email it.' }],
      delivery: { email: true },
    },
  });

/** "tell me if BTC leaves its range". */
export const btcRange = () =>
  build({
    name: 'BTC range alert',
    sentence: ['Every 5 minutes I check the BTC price and email you if it goes below $', { param: 'low' }, ' or above $', { param: 'high' }, '. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'low', label: 'Below', kind: 'number', value: 75_000, min: 1, max: 1_000_000 },
      { id: 'high', label: 'Above', kind: 'number', value: 90_000, min: 1, max: 1_000_000 },
    ],
    bindings: [
      { param: 'low', path: '/triggers/0/params/low' },
      { param: 'high', path: '/triggers/0/params/high' },
    ],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price', args: { symbol: 'BTC' } },
          // Either order works: a swapped low and high still mean the same band.
          code: 'if (input.stale) return false; const usd = Number(input.usd); return usd < Math.min(params.low, params.high) || usd > Math.max(params.low, params.high);',
          params: { low: 75_000, high: 90_000 },
          every_s: 300,
          cooldown_s: 21_600,
          mission: 'BTC left the price range the owner set. Tell them briefly which way it broke, with the price now.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me when something big happens to SOL, up or down". */
export const bigMove = () =>
  build({
    name: 'Big move alert',
    sentence: ['Every 5 minutes I look at ', { param: 'coin' }, ' and email you if it moves ', { param: 'move' }, '% or more in an hour, up or down. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'coin', label: 'Coin', kind: 'choice', options: COINS, value: 'SOL' },
      { id: 'move', label: 'Move', kind: 'number', value: 4, min: 1, max: 50, unit: '%' },
    ],
    bindings: [
      { param: 'coin', path: '/triggers/0/fetch/args/symbol' },
      { param: 'move', path: '/triggers/0/params/move_pct' },
    ],
    spec: {
      ...base,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'stellar_price_change', args: { symbol: 'SOL', window_s: 3600 } },
          code: 'return !input.stale && Math.abs(input.changePct) >= params.move_pct;',
          params: { move_pct: 4 },
          every_s: 300,
          cooldown_s: 3600,
          mission: 'The coin moved sharply in the last hour. Tell the owner briefly which way, with the price now and an hour ago.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "a weekly brief on agents that pay each other". */
export const agentEconomy = () =>
  build({
    name: 'Agent economy weekly',
    sentence: ['Every ', { param: 'when' }, ' I read the week’s news on AI agents that pay and get paid, and email you a short brief.'],
    params: [
      {
        id: 'when',
        label: 'When',
        kind: 'time',
        presets: [
          { label: 'Monday morning', value: '0 8 * * 1' },
          { label: 'Friday evening', value: '0 18 * * 5' },
        ],
        value: '0 8 * * 1',
      },
    ],
    bindings: [{ param: 'when', path: '/triggers/0/cron' }],
    spec: {
      ...base,
      tools: ['web_search', 'web_read', 'send_email'],
      triggers: [
        {
          kind: 'cron',
          cron: '0 8 * * 1',
          mission:
            'Write a short brief of the past week in the agent economy: AI agents paying and getting paid (x402, Stellar and other agent payments), on-chain agent identity (ERC-8004) and notable launches. Five items at most, each with its source link. Email it.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "prices and the one headline that matters, every morning". */
export const marketMorning = () =>
  build({
    name: 'Market morning',
    sentence: ['Every ', { param: 'when' }, ' I email you the prices of BTC, ETH and XLM with the one crypto headline that matters most that day.'],
    params: [
      {
        id: 'when',
        label: 'When',
        kind: 'time',
        presets: [
          { label: 'morning', value: '0 7 * * *' },
          { label: 'evening', value: '0 19 * * *' },
        ],
        value: '0 7 * * *',
      },
    ],
    bindings: [{ param: 'when', path: '/triggers/0/cron' }],
    spec: {
      ...base,
      tools: ['stellar_price', 'stellar_price_change', 'web_search', 'web_read', 'send_email'],
      triggers: [
        {
          kind: 'cron',
          cron: '0 7 * * *',
          mission:
            'Read the prices of BTC, ETH and XLM and their change over the last day. Find the single most important crypto headline of the last day, with its source link. Email a short note: the three prices, then the headline in two sentences.',
        },
      ],
      delivery: { email: true },
    },
  });

/*
 * More multi-chain templates. Every one only reads and emails: nothing here signs or sends, on any network. Their limits
 * follow tools/wallets.ts: EVM reads see USDC/USDT transfers only (never the native coin) and look back at most an hour, so a
 * template that needs native moves or a day-long window offers no EVM network.
 */

/** The Bitcoin genesis address: public, and a placeholder nobody spends from. */
const SAMPLE_BTC_ACCOUNT = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
/** The networks whose reads see the native coin and a whole day back: Stellar, Solana, Bitcoin. */
const NATIVE_CHAIN_OPTIONS = CHAIN_OPTIONS.filter((o) => ['stellar', 'solana', 'bitcoin'].includes(o.value));

/** "email me when a customer pays me in USDC or USDT, on whichever chain". */
export const stablecoinReceived = () =>
  build({
    name: 'Stablecoin received',
    sentence: ['Every 5 minutes I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you when ', { param: 'min' }, ' or more ', { param: 'coin' }, ' arrives. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_EVM_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: USDT_CHAIN_OPTIONS, value: 'base' },
      { id: 'coin', label: 'Coin', kind: 'choice', options: [{ label: 'USDC', value: 'USDC' }, { label: 'USDT', value: 'USDT' }], value: 'USDC' },
      {
        id: 'min',
        label: 'Minimum',
        kind: 'choice',
        options: [
          { label: '1', value: '1' },
          { label: '100', value: '100' },
          { label: '1,000', value: '1000' },
          { label: '10,000', value: '10000' },
        ],
        value: '100',
      },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'coin', path: '/triggers/0/fetch/args/asset' },
      { param: 'min', path: '/triggers/0/fetch/args/min_amount' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'base', address: SAMPLE_EVM_ACCOUNT, asset: 'USDC', min_amount: '100', direction: 'in', since_s: 420, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 300,
          cooldown_s: 420,
          mission: 'The wallet received a stablecoin payment. Say who paid, how much and on which network.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "tell me once a Bitcoin payment to me is confirmed". A block's time can trail the clock, so the window is an hour. */
export const btcReceived = () =>
  build({
    name: 'Bitcoin payment confirmed',
    sentence: ['Every 10 minutes I look at address ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you once a payment of ', { param: 'min' }, ' or more is confirmed in a block. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_BTC_ACCOUNT },
      {
        id: 'chain',
        label: 'Network',
        kind: 'choice',
        options: [
          { label: 'Bitcoin', value: 'bitcoin' },
          { label: 'Bitcoin testnet4', value: 'bitcoin-testnet4' },
        ],
        value: 'bitcoin',
      },
      {
        id: 'min',
        label: 'Minimum',
        kind: 'choice',
        options: [
          { label: '0.0001 BTC', value: '0.0001' },
          { label: '0.001 BTC', value: '0.001' },
          { label: '0.01 BTC', value: '0.01' },
          { label: '0.1 BTC', value: '0.1' },
          { label: '1 BTC', value: '1' },
        ],
        value: '0.001',
      },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
      { param: 'min', path: '/triggers/0/fetch/args/min_amount' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'bitcoin', address: SAMPLE_BTC_ACCOUNT, asset: 'native', min_amount: '0.001', direction: 'in', since_s: 3600, limit: 10 } },
          code: 'return input.payments.length > 0;',
          every_s: 600,
          cooldown_s: 3600,
          mission: 'A Bitcoin payment to the address is confirmed. Say how much arrived and from where.',
        },
      ],
      delivery: { email: true },
    },
  });

/** "my shop wallet gets paid every day: tell me if a day goes by with nothing". Only networks that read a whole day back. */
export const quietWallet = () =>
  build({
    name: 'Daily sales check-in',
    sentence: ['Every 6 hours I look at wallet ', { param: 'account' }, ' on ', { param: 'chain' }, ' and email you if nothing has arrived in the last day. Otherwise I stay quiet and spend nothing.'],
    params: [
      { id: 'account', label: 'Wallet', kind: 'text', value: SAMPLE_ACCOUNT },
      { id: 'chain', label: 'Network', kind: 'choice', options: NATIVE_CHAIN_OPTIONS, value: 'stellar' },
    ],
    bindings: [
      { param: 'account', path: '/triggers/0/fetch/args/address' },
      { param: 'chain', path: '/triggers/0/fetch/args/chain' },
    ],
    spec: {
      ...wallet,
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'wallet_payments', args: { chain: 'stellar', address: SAMPLE_ACCOUNT, direction: 'in', since_s: 86_400, limit: 1 } },
          code: 'return input.payments.length === 0;',
          every_s: 21_600,
          cooldown_s: 86_400,
          mission: 'No payment has arrived in the wallet for a whole day. Tell the owner calmly, in one or two lines.',
        },
      ],
      delivery: { email: true },
    },
  });

/** The big dollar coins besides USDC (usdcPeg watches that one), by their market ids. */
const PEGGED = ['tether', 'dai', 'ethena-usde', 'paypal-usd', 'first-digital-usd'];

/** "warn me if USDT or another big dollar coin loses its peg". */
export const stablecoinPeg = () =>
  build({
    name: 'Dollar coins check',
    sentence: ['Every 5 minutes I check that USDT, DAI, USDe, PYUSD and FDUSD are each worth a dollar and email you if one trades below $', { param: 'floor' }, '. Otherwise I stay quiet and spend nothing.'],
    params: [{ id: 'floor', label: 'Floor', kind: 'number', value: 0.99, min: 0.5, max: 0.999 }],
    bindings: [{ param: 'floor', path: '/triggers/0/params/floor' }],
    spec: {
      ...base,
      persona: 'A calm market watcher.',
      tools: ['send_email'],
      triggers: [
        {
          kind: 'condition',
          fetch: { tool: 'market_price', args: { ids: PEGGED } },
          // A coin with no price (null) never fires: a missing price is not a lost peg.
          code: "return Object.values(input.prices).some((p) => typeof p === 'number' && p < params.floor);",
          params: { floor: 0.99 },
          every_s: 300,
          cooldown_s: 3600,
          mission: 'A dollar coin is trading below a dollar. Tell the owner calmly which one, with its price now.',
        },
      ],
      delivery: { email: true },
    },
  });

export const specExamples = () => [xlmDrop(), watchAccount(), bigUsdc(), dailyDigest()];

export const EXAMPLES: { prompt: string; draft: DraftResult }[] = [
  { prompt: 'Tell me when XLM drops', draft: xlmDrop() },
  { prompt: 'Watch this wallet', draft: watchAccount() },
  { prompt: 'Alert me on a big USDC move', draft: bigUsdc() },
  { prompt: 'Send me a daily Stellar DeFi digest', draft: dailyDigest() },
];
