import { describe, expect, it } from 'bun:test';
import { schemaProblem, validate, type Schema } from '../src/specs/json-schema.js';
import { cronMinGapSeconds, cronNext, parseSpec } from '../src/specs/schema.js';

const S: Schema = {
  type: 'object',
  required: ['q'],
  additionalProperties: false,
  properties: { q: { type: 'string', maxLength: 10 }, n: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } } },
};
const base = { persona: 'A careful analyst.', system_prompt: 'Report XLM moves.' };
const service = { slug: 'summary', description: 'Summarise', price_usdc: '0.01', input_schema: { type: 'object' }, output_schema: { type: 'object' }, persona: 'p' };

describe('json schema subset', () => {
  it('accepts the subset and names the first unsupported keyword', () => {
    expect(schemaProblem(S)).toBeNull();
    expect(schemaProblem({ type: 'object', $ref: '#' })).toBe('$.$ref');
    expect(schemaProblem({ type: 'string', pattern: 'x' })).toBe('$.pattern');
    expect(schemaProblem({ type: 'object', required: ['x'], properties: {} })).toBe('$.required');
    expect(schemaProblem({ type: 'array' })).toBe('$.items');
    expect(schemaProblem({ type: 'string', properties: {} })).toBe('$.properties');
    expect(schemaProblem({ type: 'object', additionalProperties: true })).toBe('$.additionalProperties');
    expect(schemaProblem('object')).toBe('$');
    let deep: Schema = { type: 'string' };
    for (let i = 0; i < 8; i++) deep = { type: 'array', items: deep };
    expect(schemaProblem(deep)).not.toBeNull();
  });

  it('validates values and names the first mismatch', () => {
    expect(validate(S, { q: 'hi', n: 3, tags: ['a'] })).toBeNull();
    expect(validate(S, {})).toBe('$.q');
    expect(validate(S, { q: 'x'.repeat(11) })).toBe('$.q');
    expect(validate(S, { q: 'x', z: 1 })).toBe('$.z');
    expect(validate(S, { q: 'x', n: 1.5 })).toBe('$.n');
    expect(validate(S, { q: 'x', n: 9 })).toBe('$.n');
    expect(validate(S, { q: 'x', tags: ['c'] })).toBe('$.tags[0]');
    expect(validate(S, { q: 'x', tags: ['a', 'b', 'a'] })).toBe('$.tags');
    expect(validate(S, [])).toBe('$');
    expect(validate({ type: 'number' }, Number.NaN)).toBe('$');
  });

  it('ignores inherited keys: prototype names are unknown properties', () => {
    const strict: Schema = { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } } };
    expect(validate(strict, { q: 'x', constructor: {} })).toBe('$.constructor');
    expect(validate(strict, { q: 'x', toString: 5 })).toBe('$.toString');
    expect(validate(strict, { q: 'x', hasOwnProperty: [1, 2] })).toBe('$.hasOwnProperty');
    expect(validate(strict, JSON.parse('{"q":"x","__proto__":"evil"}'))).toBe('$.__proto__');
  });

  it('refuses required names that are only inherited, and still honours declared ones', () => {
    expect(schemaProblem({ type: 'object', required: ['constructor'], properties: {} })).toBe('$.required');
    const declared: Schema = { type: 'object', required: ['constructor'], properties: { constructor: { type: 'string' as const } } };
    expect(schemaProblem(declared)).toBeNull();
    expect(validate(declared, { constructor: 'ok' })).toBeNull();
    expect(validate(declared, { constructor: 1 })).toBe('$.constructor');
    expect(validate(declared, {})).toBe('$.constructor');
  });
});

describe('cron helpers', () => {
  it('measures the smallest gap and refuses non 5-field expressions', () => {
    expect(cronMinGapSeconds('*/15 * * * *')).toBe(900);
    expect(cronMinGapSeconds('0 9 * * 1')).toBe(7 * 86_400);
    expect(cronMinGapSeconds('0,5 * * * *')).toBe(300);
    expect(cronMinGapSeconds('* * * * * *')).toBeNull();
    expect(cronMinGapSeconds('nope')).toBeNull();
  });
  it('computes the next UTC run', () => {
    expect(cronNext('*/15 * * * *', new Date('2026-10-05T10:07:00Z')).toISOString()).toBe('2026-10-05T10:15:00.000Z');
  });
  it('reads a schedule in its time zone, daylight saving included; none (stored before zones) is UTC', () => {
    expect(cronNext('0 8 * * *', new Date('2026-10-05T00:00:00Z'), 'Europe/Istanbul').toISOString()).toBe('2026-10-05T05:00:00.000Z');
    expect(cronNext('0 8 * * *', new Date('2026-10-05T00:00:00Z'), null).toISOString()).toBe('2026-10-05T08:00:00.000Z');
    // New York: 08:00 is 12:00Z in summer time and 13:00Z after the clocks go back (2026-11-01).
    expect(cronNext('0 8 * * *', new Date('2026-10-30T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-10-30T12:00:00.000Z');
    expect(cronNext('0 8 * * *', new Date('2026-11-02T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });
});

describe('parseSpec', () => {
  it('a cron trigger may carry an IANA time zone, nothing else', () => {
    const cron = (tz: unknown) => parseSpec({ ...base, triggers: [{ kind: 'cron', cron: '0 8 * * *', tz, mission: 'm' }] });
    expect(cron('Europe/Istanbul').ok).toBe(true);
    expect(cron('UTC').ok).toBe(true);
    for (const bad of ['Mars/Olympus', '', 'Europe/Istanbul; drop', 3]) expect(cron(bad).ok).toBe(false);
  });
  it('fills defaults on a minimal spec', () => {
    const r = parseSpec(base);
    expect(r).toEqual({ ok: true, spec: { ...base, suggested_plan: [], tools: [], triggers: [], skills: [], services: [], delivery: { email: false }, hire_targets: [] } });
  });

  it('accepts a full spec', () => {
    const r = parseSpec({
      ...base,
      tools: ['web_search', 'stellar_price', 'send_email'],
      triggers: [
        { kind: 'cron', cron: '0 9 * * *', mission: 'Morning report.' },
        { kind: 'condition', fetch: { tool: 'stellar_price', args: { symbol: 'XLM' } }, code: 'return Number(input.usd) > 0.5', every_s: 600, mission: 'XLM is above 0.50.' },
      ],
      skills: [{ name: 'report-style', description: 'How to write reports', body: '# Style\nShort.' }],
      services: [{ ...service, tools: ['web_read'] }],
      delivery: { email: true, webhook_url: 'https://hooks.example.com/agent' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.triggers[1]).toMatchObject({ kind: 'condition', cooldown_s: 3600 });
  });

  it('a condition trigger fetching stellar_price_change parses; window_s 60 is refused', () => {
    const trig = (window_s: number) => ({ kind: 'condition', fetch: { tool: 'stellar_price_change', args: { symbol: 'XLM', window_s } }, code: 'return input.changePct <= -5', every_s: 300, mission: 'XLM fell 5% in an hour.' });
    const ok = parseSpec({ ...base, tools: ['stellar_price_change'], triggers: [trig(3600)] });
    expect(ok.ok).toBe(true);
    const bad = parseSpec({ ...base, triggers: [trig(60)] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(JSON.stringify(bad)).toContain('not valid stellar_price_change arguments');
  });

  it.each([
    [{ ...base, extra: 1 }, ''],
    [{ ...base, tools: ['web_read', 'web_read'] }, 'tools'],
    [{ ...base, tools: ['shell'] }, 'tools.0'],
    [{ ...base, triggers: [{ kind: 'cron', cron: '*/5 * * * *', mission: 'm' }] }, 'triggers.0.cron'],
    [{ ...base, triggers: [{ kind: 'condition', fetch: { tool: 'web_read', args: {} }, code: 'return true', every_s: 300, mission: 'm' }] }, 'triggers.0.fetch.tool'],
    [{ ...base, triggers: [{ kind: 'condition', fetch: { tool: 'stellar_price', args: { symbol: 'NOPE' } }, code: 'return true', every_s: 300, mission: 'm' }] }, 'triggers.0.fetch.args'],
    [{ ...base, triggers: [{ kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return true', every_s: 60, mission: 'm' }] }, 'triggers.0.every_s'],
    [{ ...base, services: [{ ...service, price_usdc: '0' }] }, 'services.0.price_usdc'],
    [{ ...base, services: [{ ...service, input_schema: { type: 'object', $ref: 'x' } }] }, 'services.0.input_schema'],
    [{ ...base, services: [{ ...service, tools: ['send_email'] }] }, 'services.0.tools.0'],
    [{ ...base, services: [{ ...service, tools: ['web_read', 'web_search', 'compute'] }] }, 'services.0.tools'],
    [{ ...base, services: [service, service] }, 'services'],
    [{ ...base, services: [{ ...service, tools: ['web_read', 'web_read'] }] }, 'services.0.tools'],
    [{ ...base, delivery: { webhook_url: 'http://hooks.example.com/h' } }, 'delivery.webhook_url'],
    [{ ...base, hire_targets: [{ url: 'https://a.example.com/a/x/y', max_usdc: '0.06' }] }, 'hire_targets.0.max_usdc'],
    [{ ...base, hire_targets: [{ url: 'http://a.example.com/a/x/y', max_usdc: '0.01' }] }, 'hire_targets.0.url'],
    [{ ...base, hire_targets: [{ url: 'http://localhost.example.com/a/x/y', max_usdc: '0.01' }] }, 'hire_targets.0.url'],
    [{ ...base, hire_targets: [{ url: 'ftp://a.example.com/a/x/y', max_usdc: '0.01' }] }, 'hire_targets.0.url'],
  ])('refuses %j at %s', (raw, path) => {
    const r = parseSpec(raw);
    expect(r.ok).toBe(false);
    if (!r.ok && path) expect(r.problem.slice(0, r.problem.indexOf(':'))).toBe(path);
    if (!r.ok && !path) expect(r.problem.startsWith(':')).toBe(false);
  });

  it.each(['https://a.example.com/a/x/y', 'http://localhost:4123/a/x/y', 'http://127.0.0.1:4123/a/x/y', 'http://[::1]:4123/a/x/y'])(
    'accepts hire target %s (plain http only on loopback, which safeFetch refuses in production)',
    (url) => {
      expect(parseSpec({ ...base, hire_targets: [{ url, max_usdc: '0.01' }] }).ok).toBe(true);
    },
  );

  it('a root-level issue has no leading colon in its problem', () => {
    const r = parseSpec({ ...base, 'unknown-key': 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.startsWith(':')).toBe(false);
  });
});

describe('condition params (data, never code)', () => {
  const cond = { kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return input.prices.stellar > params.limit', every_s: 600, cooldown_s: 60, mission: 'Alert.' };
  const spec = (t: Record<string, unknown>) => ({ ...base, triggers: [t] });

  it('a stored spec written before params existed parses unchanged', () => {
    const old = { ...cond, kind: 'condition' as const, code: 'return input.prices.stellar > 0.3' };
    const r = parseSpec(spec(old));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = r.spec.triggers[0]!;
      expect('params' in t).toBe(false);
      expect(t as unknown).toEqual(old);
    }
  });

  it('accepts numbers, strings and booleans', () => {
    const r = parseSpec(spec({ ...cond, params: { limit: 0.3, label: 'x'.repeat(100), loud: true } }));
    expect(r.ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['uppercase name', { LIMIT: 1 }],
    ['name starting with a digit', { '1a': 1 }],
    ['name over 24 chars', { ['a'.repeat(25)]: 1 }],
    ['nine entries', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, i]))],
    ['string over 100 chars', { a: 'x'.repeat(101) }],
    ['non-finite number', { a: Number.POSITIVE_INFINITY }],
    ['an object value', { a: { b: 1 } }],
    ['null', { a: null }],
    ['an array value', { a: [1] }],
  ])('refuses %s', (_n, params) => {
    const r = parseSpec(spec({ ...cond, params }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toStartWith('triggers.0.params');
  });

  it('refuses params on a cron trigger', () => {
    expect(parseSpec(spec({ kind: 'cron', cron: '0 8 * * *', mission: 'm', params: { a: 1 } })).ok).toBe(false);
  });
});
