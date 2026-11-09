import { describe, expect, it } from 'bun:test';
import { checkDraft, renderSentence, resolvePointer, type DraftResult } from '../src/builder/draft-schema.js';
import { applyParam } from '../src/builder/params.js';
import { BANNED } from '../src/builder/words.js';
import { bigUsdc, dailyDigest, specExamples, watchAccount, weeklyRecap, xlmDrop } from '../src/builder/examples.js';

const trig = (d: DraftResult) => d.spec.triggers[0]! as Extract<DraftResult['spec']['triggers'][number], { kind: 'condition' }>;
const ok = (r: ReturnType<typeof applyParam>) => {
  if (!r.ok) throw new Error(r.problem);
  return r.draft;
};

describe('checkDraft', () => {
  it('the four spec examples pass', () => {
    expect(specExamples().map((d) => checkDraft(d))).toEqual([null, null, null, null]);
  });
  it('a sentence naming an unknown param is refused', () => {
    const d = xlmDrop();
    d.sentence.push({ param: 'ghost' });
    expect(checkDraft(d)).toContain('unknown parameter ghost');
  });
  it('a param with no binding is refused', () => {
    const d = xlmDrop();
    d.bindings = [];
    expect(checkDraft(d)).toContain('has no binding');
  });
  it('a binding naming no param is refused', () => {
    const d = xlmDrop();
    d.bindings.push({ param: 'ghost', path: '/persona' });
    expect(checkDraft(d)).toContain('unknown parameter ghost');
  });
  it('a binding to a missing path is refused', () => {
    const d = xlmDrop();
    d.bindings[0]!.path = '/triggers/3/code';
    expect(checkDraft(d)).toContain('does not exist');
    const e = watchAccount();
    e.bindings[0]!.path = '/triggers/-/fetch/args/account';
    expect(checkDraft(e)).toContain('does not exist');
  });
  it('a binding whose spec value differs from the param value is refused', () => {
    const d = xlmDrop();
    d.params[0]!.value = 7;
    expect(checkDraft(d)).toContain('differs');
    const e = watchAccount();
    e.params[0]!.value = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    expect(checkDraft(e)).toContain('differs');
  });
  it('a sentence containing "cron" or "token" is refused', () => {
    for (const word of ['cron', 'token']) {
      const d = xlmDrop();
      d.sentence[0] = `Run a ${word} check. `;
      expect(checkDraft(d)).toContain(word);
    }
  });
  it('a technical label or option label is refused', () => {
    const d = bigUsdc();
    (d.params[0] as { label: string }).label = 'Passkey';
    expect(checkDraft(d)).toContain('Passkey');
    const e = bigUsdc();
    (e.params[1] as { options: { label: string }[] }).options[0]!.label = 'a token amount';
    expect(checkDraft(e)).toContain('token');
  });
  it('"free budget" and "testnet" are allowed; a bare "budget" is not', () => {
    const d = xlmDrop();
    d.sentence[0] = 'On testnet, using your Free Budget, tell me when XLM drops ';
    expect(checkDraft(d)).toBeNull();
    d.sentence[0] = 'Within your budget, tell me when XLM drops ';
    expect(checkDraft(d)).toContain('budget');
  });
  it('banned words match whole words only', () => {
    const hit = (t: string) => BANNED.some((re) => re.test(t));
    expect(hit('Tokenomics')).toBe(false);
    expect(hit('specific')).toBe(false);
    expect(hit('service')).toBe(true);
    expect(hit('Smart Wallet')).toBe(true);
    expect(hit('Wallet')).toBe(false);
    expect(hit('Passkey')).toBe(true);
    expect(hit('use your passkey')).toBe(true);
    expect(hit('TX')).toBe(true);
  });
  it('a number outside [min, max] or a choice outside its options is refused', () => {
    const d = xlmDrop();
    d.params[0]!.value = 99;
    expect(checkDraft(d)).toContain('outside');
    const e = bigUsdc();
    const size = e.params.find((p) => p.kind === 'choice' && p.id === 'size')!;
    size.value = '123';
    expect(checkDraft(e)).toContain('options');
  });
  it('a time must be a daily or weekly schedule, bound only to a cron', () => {
    const t = dailyDigest();
    t.params[0]!.value = '0 */2 * * *';
    (t.spec.triggers[0] as { cron: string }).cron = '0 */2 * * *';
    expect(checkDraft(t)).toContain('not a time');
    const mixed = dailyDigest();
    (mixed.params[0] as { presets: { label: string; value: string }[] }).presets.push({ label: 'sunday', value: '0 9 * * 0' });
    expect(checkDraft(mixed)).toContain('mixes');
    const misbound = dailyDigest();
    misbound.bindings = [{ param: 'when', path: '/delivery/email' }];
    expect(checkDraft(misbound)).not.toBeNull();
  });
  it('a time reads as its preset and hour, or as day/weekday and hour', () => {
    expect(renderSentence(dailyDigest())).toBe('Every morning at 08:00 I write a short Stellar DeFi digest and email it to you.');
    expect(renderSentence(ok(applyParam(dailyDigest(), 'when', '30 7 * * *')))).toBe('Every day at 07:30 I write a short Stellar DeFi digest and email it to you.');
    expect(renderSentence(ok(applyParam(weeklyRecap(), 'when', '15 9 * * 2')))).toContain('Every Tuesday at 09:15 I write');
  });
});

describe('params bindings', () => {
  const withCode = (code: string) => {
    const d = xlmDrop();
    trig(d).code = code;
    return d;
  };
  it('a param bound to a params key the code never reads is refused', () => {
    expect(checkDraft(withCode('return !input.stale && input.changePct <= -5;'))).toContain('never reads params.drop_pct');
    // a different key with the same prefix, or a bare `params`, is not a read of drop_pct
    expect(checkDraft(withCode('return input.changePct <= -params.drop_pct2;'))).toContain('never reads params.drop_pct');
    expect(checkDraft(withCode('return input.changePct <= -params;'))).toContain('never reads params.drop_pct');
    expect(checkDraft(withCode('return input.changePct <= -params.drop;'))).toContain('never reads params.drop_pct');
  });
  it('the knob lint is only a word search: a mention in a comment passes, and that costs a dead knob, never a wrong edit', () => {
    const d = withCode('// params.drop_pct\nreturn false;');
    expect(checkDraft(d)).toBeNull();
    const after = ok(applyParam(d, 'drop', 9));
    expect(trig(after).code).toBe(trig(d).code);
  });
  it('a params key no parameter is bound to is refused', () => {
    const d = xlmDrop();
    trig(d).params = { drop_pct: 5, extra: 1 };
    expect(checkDraft(d)).toContain('params.extra of trigger 0 is not bound');
  });
  it('a binding to a params key that does not exist is refused', () => {
    const d = xlmDrop();
    d.bindings = [{ param: 'drop', path: '/triggers/0/params/nope' }];
    expect(checkDraft(d)).toContain('does not exist');
    expect(applyParam(d, 'drop', 8).ok).toBe(false);
  });
  it('a binding to params of a cron trigger or an out-of-range trigger is refused', () => {
    const d = dailyDigest();
    d.params = [{ id: 'n', label: 'N', kind: 'number', value: 1, min: 0, max: 5 }];
    d.sentence = ['Use ', { param: 'n' }];
    d.bindings = [{ param: 'n', path: '/triggers/0/params/n' }];
    expect(checkDraft(d)).toContain('does not exist');
    d.bindings = [{ param: 'n', path: '/triggers/3/params/n' }];
    expect(checkDraft(d)).toContain('does not exist');
  });
  it('the old const field is no longer part of a binding', () => {
    const d = xlmDrop();
    (d.bindings[0] as Record<string, unknown>).const = 'DROP_PCT';
    expect(checkDraft(d)).toContain('const');
  });
  it('code, persona and a bare params object cannot be bound', () => {
    for (const path of ['/triggers/0/code', '/triggers/0/params', '/persona']) {
      const d = xlmDrop();
      d.params = [{ id: 'c', label: 'C', kind: 'text', value: 'x' }];
      d.sentence = ['Call it ', { param: 'c' }];
      d.bindings = [{ param: 'c', path }];
      expect(checkDraft(d)).not.toBeNull();
      expect(applyParam(d, 'c', 'y').ok).toBe(false);
    }
  });
});

describe('display rules', () => {
  it('"wallet" is allowed but "smart wallet" is not', () => {
    const d = xlmDrop();
    d.sentence[0] = 'Watch this wallet and tell me when XLM drops ';
    expect(checkDraft(d)).toBeNull();
    d.sentence[0] = 'Use your smart wallet to tell me when XLM drops ';
    expect(checkDraft(d)).toContain('smart wallet');
  });
  it('an asset param (CODE:G...) renders shortened like an address', () => {
    const d = watchAccount();
    d.params[0]!.value = `USDC:GABC${'A'.repeat(48)}WXYZ`;
    expect(renderSentence(d)).toBe('Every 5 minutes I look at wallet USDC:GABC\u2026WXYZ on Stellar and email you if it receives or sends money. Otherwise I stay quiet and spend nothing.');
  });
  it('a stellar address param renders shortened in the sentence', () => {
    const d = watchAccount();
    expect(renderSentence(d)).toBe('Every 5 minutes I look at wallet GAAA\u2026AAAA on Stellar and email you if it receives or sends money. Otherwise I stay quiet and spend nothing.');
    expect(d.params[0]!.value).toBe(`G${'A'.repeat(55)}`);
    expect(checkDraft(d)).toBeNull();
    expect(renderSentence(xlmDrop())).toBe('Every 5 minutes I look at XLM and email you when it is 5% or more cheaper than an hour ago, a chance to buy. Otherwise I stay quiet and spend nothing.');
  });
  it('a duplicate option value or a banned draft name is refused', () => {
    const d = bigUsdc();
    (d.params[2] as { options: { value: unknown }[] }).options[1]!.value = '1000';
    expect(checkDraft(d)).toContain('share a value');
    const e = xlmDrop();
    e.name = 'Token trigger bot';
    expect(checkDraft(e)).toContain('Token');
  });
});

describe('RFC 6901 pointers', () => {
  const doc = { a: [10, 20], 'b/c': { 'd~e': 1 }, '': 5, __proto__x: 1 };
  it('resolves ~0 ~1 and array indexes, rejects "-", leading zeros, out of range and prototype keys', () => {
    expect(resolvePointer(doc, '/a/1')).not.toBeNull();
    expect(resolvePointer(doc, '/b~1c/d~0e')).not.toBeNull();
    for (const p of ['/a/-', '/a/2', '/a/01', '/a/1.5', '/a/x', 'a/0', '', '/b~1c/d~2e', '/toString', '/__proto__', '/a/0/x']) expect({ p, r: resolvePointer(doc, p) }).toEqual({ p, r: null });
  });
});

describe('applyParam', () => {
  it('editing the threshold writes params.drop_pct and the sentence value', () => {
    const d = ok(applyParam(xlmDrop(), 'drop', 8));
    expect(trig(d).params).toEqual({ drop_pct: 8 });
    expect(d.params[0]!.value).toBe(8);
    expect(checkDraft(d)).toBeNull();
    expect(d.sentence).toContainEqual({ param: 'drop' });
  });
  it('editing minutes with scale 60 stores seconds in every_s', () => {
    const base = xlmDrop();
    base.params.push({ id: 'minutes', label: 'Check every', kind: 'number', value: 5, min: 1, max: 60, unit: 'min' });
    base.bindings.push({ param: 'minutes', path: '/triggers/0/every_s', scale: 60 });
    expect(checkDraft(base)).toBeNull();
    const d = ok(applyParam(base, 'minutes', 15));
    expect(trig(d).every_s).toBe(900);
  });
  it('a cadence below 5 minutes is refused because parseSpec refuses every_s < 300, draft unchanged', () => {
    const base = xlmDrop();
    base.params.push({ id: 'minutes', label: 'Check every', kind: 'number', value: 5, min: 1, max: 60 });
    base.bindings.push({ param: 'minutes', path: '/triggers/0/every_s', scale: 60 });
    const before = structuredClone(base);
    const r = applyParam(base, 'minutes', 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('every_s');
    expect(base).toEqual(before);
  });
  it('a number outside [min, max] is refused', () => {
    expect(applyParam(xlmDrop(), 'drop', 51).ok).toBe(false);
    expect(applyParam(xlmDrop(), 'drop', 0).ok).toBe(false);
    expect(applyParam(xlmDrop(), 'drop', '5').ok).toBe(false);
    expect(applyParam(xlmDrop(), 'drop', Number.NaN).ok).toBe(false);
  });
  it('a choice not in options is refused, one in options is written', () => {
    expect(applyParam(bigUsdc(), 'size', '123').ok).toBe(false);
    expect(trig(ok(applyParam(bigUsdc(), 'size', '100000'))).fetch.args.min_amount).toBe('100000');
  });
  it('a time takes any minute and hour, written in one form; it never turns daily into weekly or into anything else', () => {
    const d = ok(applyParam(dailyDigest(), 'when', '05 09 * * *'));
    expect((d.spec.triggers[0] as { cron: string }).cron).toBe('5 9 * * *');
    expect(d.params[0]!.value).toBe('5 9 * * *');
    expect(ok(applyParam(dailyDigest(), 'when', '0 18 * * *')).params[0]!.value).toBe('0 18 * * *');
    for (const bad of ['0 9 * * 1', '*/5 * * * *', '0 24 * * *', '60 8 * * *', '0 8 1 * *', 8, ''])
      expect(applyParam(dailyDigest(), 'when', bad).ok).toBe(false);
    expect(applyParam(weeklyRecap(), 'when', '0 9 * * *').ok).toBe(false);
    expect((ok(applyParam(weeklyRecap(), 'when', '0 9 * * 3')).spec.triggers[0] as { cron: string }).cron).toBe('0 9 * * 3');
  });
  it('a cron trigger keeps a time zone, and refuses an unknown one', () => {
    const d = dailyDigest();
    (d.spec.triggers[0] as { tz?: string }).tz = 'Europe/Istanbul';
    expect(checkDraft(d)).toBeNull();
    expect((ok(applyParam(d, 'when', '30 7 * * *')).spec.triggers[0] as { tz?: string }).tz).toBe('Europe/Istanbul');
    (d.spec.triggers[0] as { tz?: string }).tz = 'Mars/Olympus';
    expect(checkDraft(d)).toContain('time zone');
  });
  it('email/webhook choice bound to /delivery/email flips the boolean', () => {
    const d = xlmDrop();
    d.params.push({ id: 'via', label: 'Send it by', kind: 'choice', options: [{ label: 'email', value: true }, { label: 'nothing', value: false }], value: true });
    d.bindings.push({ param: 'via', path: '/delivery/email' });
    expect(checkDraft(d)).toBeNull();
    const off = ok(applyParam(d, 'via', false));
    expect(off.spec.delivery.email).toBe(false);
    expect(ok(applyParam(off, 'via', true)).spec.delivery.email).toBe(true);
  });
  it('a tap changes params, never the code', () => {
    const d = xlmDrop();
    const code = trig(d).code;
    const after = ok(applyParam(d, 'drop', 8));
    expect(trig(after).code).toBe(code);
    expect(Buffer.from(trig(after).code).equals(Buffer.from(code))).toBe(true);
    expect(trig(after).params).toEqual({ drop_pct: 8 });
    expect(trig(d).params).toEqual({ drop_pct: 5 });
  });
  it('applyParam cannot change code at all: even adversarial text and code shapes leave it byte-identical', () => {
    // These shaped the old parser-differential holes (unicode escape, regex literal, U+2028, <!--, shadowing).
    const shapes = [
      'const B = 5;\n{ const \\u0042 = 20; return input.x <= -params.drop_pct || B; }',
      "const r = /'/; let B = 20; return params.drop_pct > 1 && r.test(\"'\");",
      '// \u2028 const B = 20;\nreturn params.drop_pct > 0;',
      '<!-- x\nreturn params.drop_pct > 0;',
      '((params) => params.drop_pct)(1); return params.drop_pct > 0;',
    ];
    for (const code of shapes) {
      const d = xlmDrop();
      trig(d).code = code;
      expect(checkDraft(d)).toBeNull();
      const after = ok(applyParam(d, 'drop', 9));
      expect(trig(after).code).toBe(code);
      expect(trig(after).params).toEqual({ drop_pct: 9 });
    }
    const t = xlmDrop();
    t.params = [{ id: 'label', label: 'Label', kind: 'text', value: 'a' }];
    t.sentence = ['Call it ', { param: 'label' }];
    trig(t).params = { label: 'a' };
    trig(t).code = 'return input.label === params.label;';
    t.bindings = [{ param: 'label', path: '/triggers/0/params/label' }];
    expect(checkDraft(t)).toBeNull();
    for (const text of ['a"b', 'a\\b', 'a\nb', '"); process.exit(); ("', '\u2028']) {
      const after = ok(applyParam(t, 'label', text));
      expect(trig(after).code).toBe(trig(t).code);
      expect(trig(after).params).toEqual({ label: text });
    }
  });
  it('a text param bound to a path accepts any text the spec accepts and refuses the rest', () => {
    const d = ok(applyParam(watchAccount(), 'account', `G${'B'.repeat(55)}`));
    expect(trig(d).fetch.args.address).toBe(`G${'B'.repeat(55)}`);
    expect(applyParam(watchAccount(), 'account', 'not an address').ok).toBe(false);
  });
  it('editing twice composes', () => {
    const d = ok(applyParam(ok(applyParam(bigUsdc(), 'size', '1000')), 'account', `G${'C'.repeat(55)}`));
    expect(trig(d).fetch.args).toMatchObject({ min_amount: '1000', address: `G${'C'.repeat(55)}` });
    const x = ok(applyParam(ok(applyParam(xlmDrop(), 'drop', 10)), 'drop', 3));
    expect(trig(x).params).toEqual({ drop_pct: 3 });
  });
  it('the original draft object is never mutated', () => {
    const d = xlmDrop();
    const before = structuredClone(d);
    ok(applyParam(d, 'drop', 9));
    applyParam(d, 'drop', 99);
    expect(d).toEqual(before);
  });
  it('an unknown param is refused', () => {
    expect(applyParam(xlmDrop(), 'ghost', 1).ok).toBe(false);
  });
});

describe('revise keeps the owner\'s time zone', () => {
  it('a schedule the model writes without a zone gets the stored one', async () => {
    const { holdBack, restore } = await import('../src/builder/revise.js');
    const stored = dailyDigest();
    (stored.spec.triggers[0] as { tz?: string }).tz = 'Europe/Istanbul';
    const { held } = holdBack(stored.name, stored.spec, stored);
    expect(held.tz).toBe('Europe/Istanbul');
    const answer = ok(applyParam(dailyDigest(), 'when', '0 18 * * *'));
    const r = restore(answer, held);
    if (!r.ok) throw new Error(r.problem);
    expect((r.draft.spec.triggers[0] as { tz?: string }).tz).toBe('Europe/Istanbul');
    expect(holdBack(stored.name, dailyDigest().spec, null).held.tz).toBeUndefined();
  });
});
