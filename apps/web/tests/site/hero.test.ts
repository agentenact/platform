import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { communityFigures, HERO_PANEL_ROWS, heroLine, sinceDay } from '../../src/components/hero';
import type { FeedItem } from '../../src/lib/explore';

const TX = 'cd'.repeat(32);
const REF = 'ab'.repeat(32);
const item = (o: Partial<FeedItem>): FeedItem => ({
  seq: 7, kind: 'paid', at: '2026-10-16T11:32:37.000Z', agentId: 94, builder: 'external', otherAgentId: 95,
  amount: '0.001', label: null, selfPublished: false, link: { type: 'payment', txHash: TX }, ...o,
});

describe('heroLine', () => {
  it('names the payer first: otherAgentId paid agentId', () => {
    const l = heroLine(item({}));
    expect(l.text).toBe('#95 paid #94');
    expect(l.chip).toBe('paid');
    expect(l.amount).toBe('0.001 USDC');
    expect(l.sealOf).toBe(TX);
    expect(l.href).toContain(TX);
  });

  it('calls a payment with a proof sealed and draws its seal from the proof ref', () => {
    const l = heroLine(item({ link: { type: 'proof', ref: REF, agentUuid: null } }));
    expect(l.chip).toBe('sealed');
    expect(l.sealOf).toBe(REF);
  });

  it('describes registrations and services without amounts', () => {
    const r = heroLine(item({ kind: 'registered', amount: null, otherAgentId: null, link: { type: 'registration', txHash: TX } }));
    expect(r.text).toBe('#94 joined');
    expect(r.note).toBe(TX.slice(0, 8));
    const s = heroLine(item({ kind: 'service_opened', amount: null, label: '<b>haiku</b>', link: null }));
    expect(s.text).toBe('#94 opened “<b>haiku</b>”');
    expect(s.sealOf).toBe('seq:7');
    expect(s.note).toBe('self-published');
  });

  it('links every kind: a payment to its evidence, a new agent and a service to the agent page', () => {
    expect(heroLine(item({})).href).toBe(`https://stellar.expert/explorer/testnet/tx/${TX}`);
    expect(heroLine(item({ link: { type: 'proof', ref: REF, agentUuid: null } })).href).toContain('/verify?record=');
    expect(heroLine(item({ kind: 'registered', link: { type: 'registration', txHash: TX } })).href).toBe('/agents/94');
    expect(heroLine(item({ kind: 'service_opened', link: null })).href).toBe('/agents/94');
    expect(heroLine(item({ link: null })).href).toBe('/agents/94');
  });

  it('falls back to the agent page on a malformed link instead of throwing', () => {
    const l = heroLine(item({ link: { type: 'proof', ref: 'not a ref', agentUuid: 'x' } }));
    expect(l.href).toBe('/agents/94');
  });
});

describe('communityFigures', () => {
  it('reads the four community counts in order, grouped, with no test accounts in them', () => {
    const f = communityFigures({ people: 1204, agents: 87, seals: 3_125, txs: 9_011 });
    expect(f!.map((x) => [x.label, x.value])).toEqual([
      ['users', '1,204'],
      ['agents created', '87'],
      ['seals', '3,125'],
      ['on-chain txs', '9,011'],
    ]);
  });
  it('writes 10,000 and up short (K, M), cut down, never rounded up past the real count', () => {
    const v = (n: number) => communityFigures({ people: n, agents: 0, seals: 0, txs: 0 })![0]!.value;
    expect(v(9_999)).toBe('9,999');
    expect(v(10_000)).toBe('10K');
    expect(v(31_290)).toBe('31.2K');
    expect(v(999_999)).toBe('999.9K');
    expect(v(1_250_000)).toBe('1.2M');
  });
  it('opens a proof: seals and txs the newest one on stellar.expert, users and agents the agents built here', () => {
    const S = 'ef'.repeat(32);
    const f = communityFigures({ people: 1, agents: 1, seals: 1, txs: 1, latestSealTx: S, latestTx: TX })!;
    expect(f.map((x) => [x.key, x.href, x.external])).toEqual([
      ['people', '/explore?built=agentenact', false],
      ['agents', '/explore?built=agentenact', false],
      ['seals', `https://stellar.expert/explorer/testnet/tx/${S}`, true],
      ['txs', `https://stellar.expert/explorer/testnet/tx/${TX}`, true],
    ]);
    // before the first seal or tx, or from an api without them: the agents ranked by proofs
    const none = communityFigures({ people: 0, agents: 0, seals: 0, txs: 0 })!;
    expect(none.slice(2).map((x) => [x.href, x.external])).toEqual([
      ['/explore?built=agentenact&sort=proofs', false],
      ['/explore?built=agentenact&sort=proofs', false],
    ]);
  });

  it('is nothing for an api without the counts, so the row hides', () => {
    expect(communityFigures(undefined)).toBeNull();
  });
});

describe('panel length', () => {
  it('shows a short feed', () => {
    expect(HERO_PANEL_ROWS).toBe(3);
  });
});

describe('sinceDay', () => {
  it('names the UTC day the index stopped, or nothing', () => {
    expect(sinceDay('2026-10-20T13:45:17.385Z')).toBe('20 Oct');
    expect(sinceDay('2026-10-20T23:59:00.000-05:00')).toBe('21 Oct');
    expect(sinceDay(null)).toBeNull();
    expect(sinceDay('garbage')).toBeNull();
  });
});

describe('hero motion stays on the compositor', () => {
  const css = readFileSync(join(import.meta.dir, '../../src/app/globals.css'), 'utf8');
  /** Every @keyframes block, by name. */
  const keyframes = (() => {
    const out: Record<string, string> = {};
    for (const m of css.matchAll(/@keyframes ([\w-]+) \{/g)) {
      let i = m.index! + m[0].length;
      for (let depth = 1; depth > 0 && i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
      }
      out[m[1]!] = css.slice(m.index!, i);
    }
    return out;
  })();
  it('no keyframes read a custom property (a var() in keyframes is animated on the main thread)', () => {
    expect(Object.keys(keyframes)).toContain('twinkle');
    for (const [name, body] of Object.entries(keyframes)) expect([name, body.includes('var(')]).toEqual([name, false]);
  });
  it('animates only transform and opacity, so nothing repaints or restyles per frame', () => {
    for (const name of ['twinkle', 'sway-1', 'sway-2', 'sway-3', 'nebula-a', 'meteor', 'drift']) {
      expect(keyframes[name]).toBeDefined();
      const props = [...keyframes[name]!.matchAll(/([\w-]+):/g)].map((m) => m[1]);
      for (const p of props) expect([name, ['transform', 'opacity'].includes(p!)]).toEqual([name, true]);
    }
  });
  it('twinkles whole star layers, never single stars', () => {
    expect(css).toMatch(/\.sky-layer\[data-twinkle\] \{\s*animation: twinkle/);
    expect(css).not.toMatch(/\.star\b/);
  });
  it('moves only when motion is welcome, and pauses with the hero', () => {
    const hero = css.slice(css.indexOf('/* ---- Hero: deep space'), css.indexOf('/* The ask: a field'));
    const outsideMotion = hero.slice(0, hero.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(outsideMotion).not.toMatch(/animation:/);
    expect(hero).toMatch(/\.night\[data-paused\] \*/);
  });
});
