import type { FeedItem, Overview } from '../../src/lib/agent-types';

export const AGENT_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
export const NOW = Date.parse('2026-10-13T12:00:00Z');

export const overview = (o: Partial<Overview> = {}): Overview => ({
  name: 'XLM drop watcher',
  status: 'watching',
  nextCheckAt: '2026-10-13T12:03:00Z',
  lastAlertAt: '2026-10-12T09:14:00Z',
  checksToday: 288,
  alertsThisWeek: 1,
  earnedUsdc: '0.0030000',
  salesCount: 3,
  budgetUsedPct: 4,
  watchingSince: '2026-10-10T12:00:00Z',
  checksTotal: 900,
  watchesCondition: true,
  running: false,
  lastRun: null,
  latestCheck: { at: '2026-10-13T11:57:00Z', held: false, reading: { symbol: 'XLM', changePct: -0.4, from: 0.1045, to: 0.1041 } },
  morningNote: null,
  model: {
    current: 'deepseek/deepseek-v4.1-flash',
    chosen: null,
    defaultId: 'deepseek/deepseek-v4.1-flash',
    choices: [
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', weight: 1, suggested: true },
      { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', weight: 1.4, suggested: true },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', weight: 26.5, suggested: true },
    ],
    catalog: true,
  },
  ...o,
});

export const feed = (): FeedItem[] => [
  { type: 'sale', at: '2026-10-13T08:05:00Z', usdc: '0.0010000', proofUrl: 'https://agentenact.io/verify?agent=a&tx=b' },
  { type: 'quiet', at: '2026-10-13T11:55:00Z', day: '2026-10-13', count: 24 },
  { type: 'alert', at: '2026-10-12T09:14:00Z', text: 'XLM fell 5.8% in an hour.' },
  { type: 'problem', at: '2026-10-12T07:00:00Z' },
];
