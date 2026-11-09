import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Numbers } from '../../src/components/explore-numbers';
import { FeedList } from '../../src/components/feed';
import { AgentCards } from '../../src/components/agent-list';
import { ProfileView } from '../../src/components/agent-profile';
import ExplorePage from '../../src/app/(site)/explore/page';
import type { AgentCard, AgentProfile, FeedItem, Stats } from '../../src/lib/explore';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const REF = 'ab'.repeat(32);
const TX = 'cd'.repeat(32);
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OWNER = 'GABGUOWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNSVL73';
const WALLET = 'GDO73WALLETWALLETWALLETWALLETWALLETWALLETWALLETWALLETAWECM';
const PAYER = 'GCH36PAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYERPANKNZ3';
// Planted in fields no component may render. A spread of a raw object would leak them.
const EMAIL = 'secret.person@private-mail.example';
const MISSION = 'MISSION-PROMPT-do-the-confidential-thing';
const planted = { email: EMAIL, ownerEmail: EMAIL, mission: MISSION, prompt: MISSION, apiKey: 'sk-planted-key' };

const stats: Stats = {
  network: 'testnet', agents: 1234, provenOutputs: 56, usdcProven: '0', usdcTransfers: '213.4', activeLastHour: 7,
  asOf: '2026-10-12T10:00:00.000Z', indexedThrough: '2026-10-12T09:59:50.000Z', stale: false,
};

const feed = (o: Partial<FeedItem> & { seq: number }): FeedItem =>
  ({
    kind: 'paid', at: '2026-10-12T09:59:00.000Z', agentId: 45, builder: 'hosted', otherAgentId: 46,
    amount: '0.001', label: null, selfPublished: false, link: null, ...planted, ...o,
  }) as FeedItem;
const feedItems: FeedItem[] = [
  feed({ seq: 1, link: { type: 'proof', ref: REF, agentUuid: UUID } }),
  feed({ seq: 2, builder: 'library', link: { type: 'proof', ref: REF, agentUuid: null } }),
  feed({ seq: 3, builder: 'external', link: { type: 'payment', txHash: TX } }),
  feed({ seq: 4, otherAgentId: null }),
  feed({ seq: 5, kind: 'registered', amount: null, otherAgentId: null, link: { type: 'registration', txHash: TX } }),
  feed({ seq: 6, kind: 'registered', builder: 'external', amount: null, otherAgentId: null }),
  feed({ seq: 7, kind: 'service_opened', amount: null, otherAgentId: null, label: 'haiku', selfPublished: true }),
];

const card = (o: Partial<AgentCard>): AgentCard =>
  ({
    id: 45, builder: 'hosted', selfPublished: null, paymentsReceived: 7, usdcReceived: '0.007', provenSales: 3,
    lastActiveAt: '2026-10-12T09:00:00.000Z', lastPaymentAt: '2026-10-12T09:00:00.000Z', ...planted, ...o,
  }) as AgentCard;
const cards: AgentCard[] = [
  card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: '0.001' }, ...planted } as AgentCard['selfPublished'] }),
  card({ id: 46, builder: 'library', selfPublished: { name: null, service: { slug: 'sonnet', description: null, priceUsdc: null } } }),
  card({ id: 47, builder: 'external', lastActiveAt: null }),
];

const profile = (o: Partial<AgentProfile> = {}): AgentProfile =>
  ({
    id: 46, owner: OWNER, wallet: WALLET, builder: 'hosted',
    registered: { at: '2026-10-01T08:00:00.000Z', txHash: TX, source: 'event' },
    lastActiveAt: '2026-10-12T09:00:00.000Z',
    totals: { paymentsReceived: 2, usdcReceived: '0.002', provenSales: 1 },
    history: [
      { at: '2026-10-12T09:00:00.000Z', amount: '0.001', payer: PAYER, txHash: TX, proof: { ref: REF, agentUuid: UUID } },
      { at: '2026-10-11T09:00:00.000Z', amount: '0.001', payer: PAYER, txHash: 'ee'.repeat(32), proof: null },
    ],
    selfPublished: {
      name: 'Pixel Poet', description: 'Writes haiku',
      services: [{ slug: 'haiku', description: 'A haiku', priceUsdc: '0.001' }, { slug: 'free', description: null, priceUsdc: null }],
      fetchedAt: '2026-10-12T09:00:00.000Z',
    },
    hidden: false, links: { karma: 'x' }, ...planted, ...o,
  }) as AgentProfile;
const profiles: AgentProfile[] = [
  profile(),
  profile({ id: 47, builder: 'library', registered: { at: null, txHash: null, source: 'registry_read' }, wallet: null, history: [], lastActiveAt: null }),
  profile({ id: 48, builder: 'external', selfPublished: null }),
  profile({ id: 49, hidden: true }),
];

const el = (c: unknown, p: object) => renderToStaticMarkup(createElement(c as never, p));

/** What a person reads: no tags, no attribute values, no Advanced block, entities decoded. */
const visible = (markup: string) =>
  markup
    .replace(/<details[\s\S]*?<\/details>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

const header = el(ExplorePage, {});
const surfaces: Record<string, string> = {
  'numbers strip': el(Numbers, { stats, variant: 'strip' }),
  'numbers full': el(Numbers, { stats, variant: 'full' }),
  header,
  feed: el(FeedList, { items: feedItems, now: NOW }),
  cards: el(AgentCards, { items: cards, now: NOW }),
  ...Object.fromEntries(profiles.map((p) => [`profile #${p.id}`, el(ProfileView, { profile: p, now: NOW })])),
};
const all = Object.entries(surfaces);

describe('explore words and privacy guard', () => {
  it('shows no technical term by default', () => {
    // The approved Ledger copy names wallets in the count definitions, so `wallet` is not banned here.
    const banned = /\b(tx|hash(es)?|ledger|soroban|horizon|sha-?256|signature|settlement|on-?chain|agentId|nonce)\b/i;
    const fullAddress = /G[A-Z2-7]{55}/;
    for (const [name, markup] of all) {
      const text = visible(markup);
      expect([name, banned.exec(text)?.[0]]).toEqual([name, undefined]);
      expect([name, fullAddress.exec(text)?.[0]]).toEqual([name, undefined]);
    }
    const page = ['numbers strip', 'numbers full', 'header', 'feed', 'cards'].map((k) => visible(surfaces[k]!)).join(' ');
    // once in the source block, once in the first count's definition
    expect((page.match(/stellar-8004/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('says Testnet where money is mentioned', () => {
    expect(visible(surfaces['numbers full']!)).toMatch(/testnet/i);
    expect(visible(surfaces['numbers strip']!)).toContain('Testnet');
    expect(visible(header)).toMatch(/testnet/i);
    expect(visible(surfaces['profile #46']!)).toContain('Testnet');
  });

  it('never claims correctness', () => {
    const claims = /\b(correct|accurate|verified correct|quality|trusted|score)\b/i;
    for (const [name, markup] of all) {
      expect([name, claims.exec(visible(markup))?.[0]]).toEqual([name, undefined]);
    }
  });

  it('shows no private fields', () => {
    for (const [name, markup] of all) {
      for (const secret of [EMAIL, MISSION, 'sk-planted-key']) expect([name, markup.includes(secret)]).toEqual([name, false]);
    }
  });
});
