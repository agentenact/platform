import { hireOf, type AgentCard, type HireOffer, type KarmaScore } from './explore';

/** The market lists only agents that can be hired, most paid first: the same /public/agents query Explore's "For hire" chip runs. */
export function marketPath(q: string, cursor?: string): string {
  const p = new URLSearchParams({ hire: '1', sort: 'paid', limit: '50' });
  if (q.trim()) p.set('q', q.trim().slice(0, 64));
  if (cursor) p.set('cursor', cursor);
  return `/public/agents?${p}`;
}

/** Cards that can be hired. An api older than `hire=1` returns every agent, so the list is narrowed here as well. */
export const forHire = (items: AgentCard[]): AgentCard[] => items.filter((a) => hireOf(a) !== null);

export type Price = { usdc: string; per: 'call' | 'from' } | null;

/** The price a card shows: per call when its one service carries it, "from" when it is the lowest of several; null when the agent quotes it. */
export function priceOf(a: AgentCard): Price {
  const usdc = hireOf(a)?.priceUsdc ?? null;
  if (!usdc) return null;
  return { usdc, per: a.selfPublished?.service?.priceUsdc === usdc ? 'call' : 'from' };
}

/** The service a card names; the manifest pointer (stellar-agent-services) is where prices live, not a service of its own. */
export function serviceOf(a: AgentCard): { slug: string; description: string | null } | null {
  const s = a.selfPublished?.service;
  return s && s.slug !== 'stellar-agent-services' ? { slug: s.slug, description: s.description } : null;
}

export const agentName = (a: AgentCard): string => a.selfPublished?.name || `Agent #${a.id}`;

/** Where an AI tool gets the AgentEnact tools (owner MCP: get_agent, hire_agent). */
export const CONNECT_URL = 'https://agentenact.io/connect';
/** The most hire_agent pays for one call (api MAX_HIRE_PER_CALL_USDC). */
export const HIRE_CAP_USDC = '0.05';

const SLUG = /^[a-z0-9-]{1,64}$/;
const PRICE = /^\d{1,6}(\.\d{1,7})?$/;
/** A url safe to put in a prompt: https, no spaces or quotes, short. The agent wrote it, so anything else is dropped. */
function safeUrl(u: string | undefined): string | null {
  if (!u || u.length > 300 || !/^https:\/\/[^\s"'<>`]+$/.test(u)) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * What to paste into an AI tool to hire an agent once: which tools to use, in which order, what it costs, and where to
 * get the tools when the app has none. Only values we checked go in: the on-chain id, the service slug ([a-z0-9-]),
 * an https url and a decimal price. The agent's name and descriptions are its own free text, so none of it goes in.
 */
export function hirePrompt(a: { id: number; hire?: HireOffer | null; selfPublished?: AgentCard['selfPublished'] }): string {
  const svc = a.hire?.service ?? null;
  const slug = svc && SLUG.test(svc.slug) ? svc.slug : (() => {
    const s = a.selfPublished?.service?.slug;
    return s && s !== 'stellar-agent-services' && SLUG.test(s) ? s : null;
  })();
  const url = safeUrl(svc?.url);
  const price = a.hire?.priceUsdc && PRICE.test(a.hire.priceUsdc) ? a.hire.priceUsdc : null;
  const what = slug ? `its ${slug} service` : 'its paid service';
  const cost = price
    ? `It costs ${price} USDC a call on Stellar testnet, paid from one of my agents' wallets.`
    : `It quotes its price when called; pay at most ${HIRE_CAP_USDC} USDC on Stellar testnet, from one of my agents' wallets.`;
  return [
    `Hire AgentEnact agent #${a.id} once, for ${what}, with the AgentEnact tools.`,
    `1. Call get_agent with agent_id "${a.id}" and read the input ${slug ? `the ${slug} service` : 'its service'} asks for${url ? '' : ' and its url'}.`,
    '2. Ask me for any value it needs that I have not given you.',
    `3. Call hire_agent with ${url ? `url ${url}` : 'that url'} and that input. ${cost}`,
    '4. Show me what it sends back and whether its Enactment Record verified.',
    `No get_agent or hire_agent tool here? Connect AgentEnact to this app first: ${CONNECT_URL}`,
  ].join('\n');
}

// ---- Discovery: categories, search, filters, sort and shelves over the whole for-hire list ----------------------
//
// The market is small (tens of agents), so the page reads every agent for hire once (MARKET_PAGES × 50) and does search,
// filters and sort in the browser: every tap answers at once and the counts on each chip are exact. Nothing here goes
// to the api; the view lives in the page url so a filtered list can be shared.

/** At most this many /public/agents pages of 50 are read; past that the list says it is cut. */
export const MARKET_PAGES = 4;

export const CATEGORIES = [
  { id: 'prices', label: 'Prices & markets', words: 'price prices market coin crypto' },
  { id: 'wallets', label: 'Wallets & payments', words: 'wallet wallets payment payments balance money' },
  { id: 'news', label: 'News & research', words: 'news research digest recap brief headline' },
  { id: 'make', label: 'Design & documents', words: 'design document deck slides logo brand' },
  { id: 'tools', label: 'Tools for agents', words: 'tool tools api trust identity browser data' },
  { id: 'other', label: 'Other', words: '' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];

/**
 * What an agent does, read from its own words (service slug, name, descriptions). Agents publish no category field, so
 * this is a guess: the first rule that matches wins, ordered so a narrow kind beats a broad one ("a digest of prices"
 * is news; "USDC moves by a wallet" is a wallet, not a price). tests/site/market.test.ts pins every house agent's offer.
 */
const RULES: readonly [Exclude<CategoryId, 'other'>, RegExp][] = [
  ['make', /\b(pitch|deck|slides?|pptx|logos?|wordmarks?|branding|brand|designs?|designer|illustrations?|images?|svg|copywrit\w*|essays?)\b/],
  ['news', /\b(digest|recap|headlines?|brief|news|research\w*|newsletter|summar\w*|articles?|reports?)\b/],
  ['tools', /\b(trust|identity|reputation|verif\w*|kya|oracle|render\w*|browser|scrap\w*|crawl\w*|classif\w*|labels?|words?|translat\w*|extract\w*|ocr|transcri\w*|api)\b/],
  ['wallets', /\b(wallets?|payments?|paid|balance|holds|received|arrived|sent|address|transfers?|moves)\b/],
  ['prices', /\b(prices?|cheaper|dip|bargain|peg|dollar|rose|range|target|markets?|btc|eth|sol|xlm|coins?|trading)\b/],
];

const textOf = (a: AgentCard): string => {
  const s = a.selfPublished;
  return [s?.service?.slug?.replace(/-/g, ' '), s?.name, s?.service?.description, s?.description].filter(Boolean).join(' \n ').toLowerCase();
};

export function categoryOf(a: AgentCard): CategoryId {
  const t = textOf(a);
  for (const [id, re] of RULES) if (re.test(t)) return id;
  return 'other';
}

export const categoryLabel = (id: CategoryId): string => CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';

/** A test or placeholder listing: kept in the full list, never put forward on a shelf. */
export const isTestListing = (a: AgentCard): boolean =>
  /\b(test|testing|placeholder|demo|dummy)\b/i.test(`${a.selfPublished?.name ?? ''} ${a.selfPublished?.description ?? ''}`) ||
  !a.selfPublished?.name;

/** Has a rating worth showing: AgentKarma scores an agent nobody has paid yet as Poor, which says nothing about it. */
export const ratedOf = (a: AgentCard): KarmaScore =>
  a.karma && a.karma.score !== null && a.karma.tier !== 'Unrated' && (a.paymentsReceived ?? 0) > 0 ? a.karma : null;

export const isGoodKarma = (a: AgentCard): boolean => (ratedOf(a)?.score ?? 0) >= 60;
export const isHiredBefore = (a: AgentCard): boolean => (a.paymentsReceived ?? 0) > 0;
export const hasProofs = (a: AgentCard): boolean => a.provenSales > 0 || (a.seals ?? 0) > 0;
export const isBuiltHere = (a: AgentCard): boolean => a.builder !== 'external';
const WEEK = 7 * 24 * 3600 * 1000;
export const isActive = (a: AgentCard, now: number): boolean => {
  const t = Date.parse(a.lastActiveAt ?? '');
  return Number.isFinite(t) && now - t < WEEK;
};

/** A price as a number for comparing; null when the agent quotes it. */
export const priceNum = (a: AgentCard): number | null => {
  const p = hireOf(a)?.priceUsdc;
  const n = p ? Number(p) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const PRICE_CAPS = [
  { id: '0.01', label: '1¢ or less', max: 0.01 },
  { id: '0.05', label: '5¢ or less', max: 0.05 },
  { id: '0.1', label: '10¢ or less', max: 0.1 },
] as const;
export type PriceCap = (typeof PRICE_CAPS)[number]['id'] | null;

export const FLAGS = [
  { id: 'hired', label: 'Hired before', test: (a: AgentCard) => isHiredBefore(a) },
  { id: 'proof', label: 'Has proofs', test: (a: AgentCard) => hasProofs(a) },
  { id: 'rated', label: 'Well rated', test: (a: AgentCard) => isGoodKarma(a) },
  { id: 'here', label: 'Built on AgentEnact', test: (a: AgentCard) => isBuiltHere(a) },
  { id: 'active', label: 'Active this week', test: (a: AgentCard, now: number) => isActive(a, now) },
] as const;
export type FlagId = (typeof FLAGS)[number]['id'];

export const MARKET_SORTS = [
  { id: 'best', label: 'Best match' },
  { id: 'hired', label: 'Most hired' },
  { id: 'cheap', label: 'Lowest price' },
  { id: 'rated', label: 'AgentKarma' },
  { id: 'new', label: 'Newest' },
] as const;
export type MarketSort = (typeof MARKET_SORTS)[number]['id'];

export interface MarketView {
  q: string;
  cat: CategoryId | null;
  price: PriceCap;
  flags: FlagId[];
  sort: MarketSort;
  /** The whole list asked for with nothing narrowed ("See all"): `?view=all`. */
  all: boolean;
}

export const EMPTY_VIEW: MarketView = { q: '', cat: null, price: null, flags: [], sort: 'best', all: false };

/** Browsing (the shelves) until the visitor searches, narrows, re-sorts or asks for the whole list. */
export const isBrowsing = (v: MarketView): boolean =>
  !v.all && !v.q.trim() && v.cat === null && v.price === null && v.flags.length === 0 && v.sort === 'best';

/** How many things narrow the list (the search not counted): the number on "Clear". */
export const narrowCount = (v: MarketView): number => (v.cat ? 1 : 0) + (v.price ? 1 : 0) + v.flags.length;

export function marketViewFromParams(p: URLSearchParams): MarketView {
  const cat = p.get('cat');
  const price = p.get('price');
  const sort = p.get('sort');
  const flags = (p.get('only') ?? '').split(',').filter((f): f is FlagId => FLAGS.some((x) => x.id === f));
  return {
    q: (p.get('q') ?? '').slice(0, 64),
    cat: CATEGORIES.some((c) => c.id === cat) ? (cat as CategoryId) : null,
    price: PRICE_CAPS.some((c) => c.id === price) ? (price as PriceCap) : null,
    flags: [...new Set(flags)],
    sort: MARKET_SORTS.some((s) => s.id === sort) ? (sort as MarketSort) : 'best',
    all: p.get('view') === 'all',
  };
}

export function marketViewParams(v: MarketView): URLSearchParams {
  const p = new URLSearchParams();
  if (v.q.trim()) p.set('q', v.q.trim());
  if (v.cat) p.set('cat', v.cat);
  if (v.price) p.set('price', v.price);
  if (v.flags.length) p.set('only', FLAGS.filter((f) => v.flags.includes(f.id)).map((f) => f.id).join(','));
  if (v.sort !== 'best') p.set('sort', v.sort);
  if (v.all && isBrowsing({ ...v, all: false })) p.set('view', 'all');
  return p;
}

/**
 * How strongly a card answers the search: every word must appear somewhere (name, service, descriptions, its kind's
 * label and words, or "#id"); a hit in the name or service counts more than one in a description. 0: no match.
 */
export function matchScore(a: AgentCard, q: string): number {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const s = a.selfPublished;
  const cat = CATEGORIES.find((c) => c.id === categoryOf(a))!;
  const head = `${s?.name ?? ''} ${s?.service?.slug?.replace(/-/g, ' ') ?? ''}`.toLowerCase();
  const body = `${s?.service?.description ?? ''} ${s?.description ?? ''} ${cat.label} ${cat.words}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    const id = /^#?(\d{1,10})$/.exec(w);
    if (id && Number(id[1]) === a.id) score += 5;
    else if (head.includes(w)) score += 3;
    else if (body.includes(w)) score += 1;
    else return 0;
  }
  return score;
}

/** Standing: how much a stranger can lean on an agent, from what is on record. Ranks "Best match" and the top picks. */
export function standing(a: AgentCard, now: number): number {
  const paid = a.paymentsReceived ?? 0;
  const rated = ratedOf(a)?.score ?? 0;
  return (
    Math.min(paid, 50) * 2 +
    rated / 5 +
    (hasProofs(a) ? 8 : 0) +
    (isBuiltHere(a) ? 6 : 0) +
    (priceNum(a) !== null ? 4 : 0) +
    (serviceOf(a)?.description || a.selfPublished?.description ? 3 : 0) +
    (isActive(a, now) ? 4 : 0) -
    (isTestListing(a) ? 40 : 0)
  );
}

const cmpPrice = (a: AgentCard, b: AgentCard): number => (priceNum(a) ?? Infinity) - (priceNum(b) ?? Infinity);

export function sortCards(items: AgentCard[], sort: MarketSort, now: number, q = ''): AgentCard[] {
  const by: Record<MarketSort, (a: AgentCard, b: AgentCard) => number> = {
    best: (a, b) => matchScore(b, q) - matchScore(a, q) || standing(b, now) - standing(a, now) || b.id - a.id,
    hired: (a, b) => (b.paymentsReceived ?? -1) - (a.paymentsReceived ?? -1) || standing(b, now) - standing(a, now),
    cheap: (a, b) => cmpPrice(a, b) || standing(b, now) - standing(a, now),
    rated: (a, b) => (ratedOf(b)?.score ?? -1) - (ratedOf(a)?.score ?? -1) || standing(b, now) - standing(a, now),
    new: (a, b) => b.id - a.id,
  };
  return [...items].sort(by[sort]);
}

/** Every filter but one (`skip`), so a chip can count what it would show if it were the one changed. */
export function applyView(items: AgentCard[], v: MarketView, now: number, skip?: 'cat' | 'price' | FlagId): AgentCard[] {
  const cap = PRICE_CAPS.find((c) => c.id === v.price)?.max;
  return items.filter(
    (a) =>
      matchScore(a, v.q) > 0 &&
      (skip === 'cat' || v.cat === null || categoryOf(a) === v.cat) &&
      (skip === 'price' || cap === undefined || (priceNum(a) ?? Infinity) <= cap) &&
      FLAGS.every((f) => f.id === skip || !v.flags.includes(f.id) || f.test(a, now)),
  );
}

export interface Shelf {
  id: string;
  title: string;
  note: string;
  items: AgentCard[];
  /** The view "See all" opens. */
  view: Partial<MarketView>;
}

/**
 * The browsing shelves, each an honest cut of the list (no paid placement, no hand-picked order): the top picks, the
 * most hired, one shelf per kind, then the newest. A top pick is not repeated on the shelves below it. Test listings
 * never appear on one, and a shelf with fewer than two agents is left out.
 */
export function shelvesOf(items: AgentCard[], now: number): { picks: AgentCard[]; shelves: Shelf[] } {
  const real = items.filter((a) => !isTestListing(a));
  const ranked = sortCards(real, 'best', now);
  const picks = ranked.slice(0, 3);
  const rest = ranked.filter((a) => !picks.includes(a));
  const n = 10;
  const shelves: Shelf[] = [
    { id: 'hired', title: 'Most hired', note: 'Agents other agents already paid.', items: sortCards(rest.filter(isHiredBefore), 'hired', now).slice(0, n), view: { flags: ['hired'], sort: 'hired' } },
    ...CATEGORIES.filter((c) => c.id !== 'other').map((c) => ({
      id: c.id,
      title: c.label,
      note: KIND_NOTES[c.id],
      items: rest.filter((a) => categoryOf(a) === c.id).slice(0, n),
      view: { cat: c.id } as Partial<MarketView>,
    })),
    { id: 'new', title: 'New here', note: 'The latest agents to open for hire.', items: sortCards(rest, 'new', now).slice(0, n), view: { sort: 'new' } },
  ];
  return { picks, shelves: shelves.filter((s) => s.items.length >= 2) };
}

const KIND_NOTES: Record<Exclude<CategoryId, 'other'>, string> = {
  prices: 'Live prices, dips, jumps and dollar pegs, checked when you ask.',
  wallets: 'What a wallet holds, sent and received, on Stellar and other chains.',
  news: 'Short digests and recaps, each point with its source.',
  make: 'Decks, logos and other files made from what you give them.',
  tools: 'Building blocks other agents call: checks, rendering, labels.',
};
