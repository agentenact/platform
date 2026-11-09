import { describe, expect, test } from 'bun:test';
import { HOUSE_EMAIL_REGEX, NOT_COMMUNITY_EMAIL_REGEX, TEST_EMAIL_REGEX } from '../../api/src/test-accounts';
import { bannedWord } from '../../api/src/builder/words';
import { parseSpec } from '../../api/src/specs/schema';
import { BUYERS, EXTRAS, houseAgents, OFFERS } from '../scripts/house-agents/services';
import { TEMPLATES } from '../src/lib/templates';

describe('house agents', () => {
  test('one agent per template and per extra, none left over', () => {
    const all = [...TEMPLATES, ...EXTRAS].map((t) => t.id);
    expect(houseAgents().map((a) => a.templateId)).toEqual(all);
    expect(Object.keys(OFFERS).sort()).toEqual([...all].sort());
  });

  for (const a of houseAgents()) {
    test(`${a.templateId}: the api accepts the description, and it only answers paid calls`, () => {
      const r = parseSpec(a.spec);
      if (!r.ok) throw new Error(r.problem);
      expect(r.spec.triggers).toEqual([]);
      expect(r.spec.tools).toEqual([]);
      expect(r.spec.delivery).toEqual({ email: false });
      expect(r.spec.services).toHaveLength(1);
      expect(Number(r.spec.services[0]!.price_usdc)).toBeLessThanOrEqual(0.05);
      expect(bannedWord(a.name)).toBeNull();
    });
  }

  test('a buyer, once its sellers exist, hires exactly two other house offers on a schedule, within their prices', () => {
    const ids = Object.fromEntries([...TEMPLATES, ...EXTRAS].map((t, i) => [t.id, `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`]));
    const all = houseAgents(ids);
    expect(Object.keys(BUYERS).length).toBeGreaterThan(0);
    for (const a of all) {
      const r = parseSpec(a.spec);
      if (!r.ok) throw new Error(`${a.templateId}: ${r.problem}`);
      const b = BUYERS[a.templateId];
      if (!b) {
        expect([a.templateId, r.spec.triggers, r.spec.hire_targets]).toEqual([a.templateId, [], []]);
        continue;
      }
      expect(r.spec.tools).toEqual(['hire_agent']);
      expect(r.spec.delivery).toEqual({ email: false });
      expect(r.spec.triggers).toHaveLength(1);
      expect(r.spec.hire_targets).toEqual(
        b.buys.map((p) => ({ url: `https://api.agentenact.io/a/${ids[p.from]}/${OFFERS[p.from]!.slug}`, max_usdc: OFFERS[p.from]!.price })),
      );
      for (const p of b.buys) {
        expect(p.from).not.toBe(a.templateId);
        // The input the mission sends is one the seller's own schema accepts (no extra keys, every required one).
        const schema = OFFERS[p.from]!.input as { properties: Record<string, unknown>; required: string[] };
        expect(Object.keys(p.input).sort()).toEqual([...schema.required].sort());
      }
      const t = r.spec.triggers[0]!;
      for (const target of r.spec.hire_targets) expect(t.mission).toContain(target.url);
    }
    // Before the sellers exist, a buyer is created as a plain seller.
    for (const a of houseAgents()) expect(a.spec.hire_targets).toBeUndefined();
  });

  test('each agent has its own account: counted in the community, never hit by the bulk test pause', () => {
    const emails = houseAgents().map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) {
      expect([e, new RegExp(HOUSE_EMAIL_REGEX).test(e)]).toEqual([e, true]);
      expect([e, new RegExp(NOT_COMMUNITY_EMAIL_REGEX).test(e)]).toEqual([e, false]);
      expect([e, new RegExp(TEST_EMAIL_REGEX).test(e)]).toEqual([e, false]);
    }
  });

  test('no offer plans more tool calls than a paid run allows, which would fail every call', () => {
    for (const [id, o] of Object.entries(OFFERS)) expect([id, o.tools.length <= 2, o.tools.includes('web_read')]).toEqual([id, true, false]);
  });

  test('slugs are unique, so a buyer can tell the offers apart', () => {
    const slugs = Object.values(OFFERS).map((o) => o.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
