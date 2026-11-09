import { describe, expect, test } from 'bun:test';
import { createParker } from '../src/lib/sign-in-park';

type Out = { ok: true; id: string } | { ok: false };
const draft = { name: 'x' };

describe('parking the draft before the link is sent', () => {
  test('is done once per address: a resend to the same address reuses it (case does not matter)', async () => {
    let calls = 0;
    const park = createParker(async () => (calls++, { ok: true, id: 'h1' } as Out));
    expect(await park(draft, 'A@b.co')).toBe('h1');
    expect(await park(draft, 'a@b.co')).toBe('h1');
    expect(calls).toBe(1);
  });

  test('a different address parks again', async () => {
    let calls = 0;
    const park = createParker(async () => (calls++, { ok: true, id: `h${calls}` } as Out));
    expect(await park(draft, 'a@b.co')).toBe('h1');
    expect(await park(draft, 'c@d.co')).toBe('h2');
  });

  test('a park that failed is tried again on "Send again", so the link does not go out without the draft for good', async () => {
    const answers: Out[] = [{ ok: false }, { ok: true, id: 'h9' }];
    let calls = 0;
    const park = createParker(async () => answers[calls++]!);
    expect(await park(draft, 'a@b.co')).toBeUndefined();
    expect(await park(draft, 'a@b.co')).toBe('h9');
    expect(calls).toBe(2);
  });

  test('a park that threw is tried again too', async () => {
    let calls = 0;
    const park = createParker(async () => (calls++ === 0 ? Promise.reject(new Error('net')) : ({ ok: true, id: 'h2' } as Out)));
    expect(await park(draft, 'a@b.co')).toBeUndefined();
    expect(await park(draft, 'a@b.co')).toBe('h2');
  });

  test('with no draft there is nothing to park and the api is never called', async () => {
    let calls = 0;
    const park = createParker(async () => (calls++, { ok: true, id: 'h' } as Out));
    expect(await park(undefined, 'a@b.co')).toBeUndefined();
    expect(await park(null, 'a@b.co')).toBeUndefined();
    expect(calls).toBe(0);
  });
});
