import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerifyView, type VerifyState } from '../../src/components/verify-view';
import { parseVerifyParams, recordUrl } from '../../src/lib/verify-params';
import { checkRecord, type VerifierModule } from '../../src/lib/verify-record';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const TX = 'ab'.repeat(32);
const PUBLIC_RECORD = `https://api.agentenact.io/public/records/${TX}`;

describe('parseVerifyParams', () => {
  it('accepts a uuid and a 64-hex tx, and a public record url on api.agentenact.io', () => {
    expect(parseVerifyParams(`?agent=${UUID}&tx=${TX}`)).toEqual({ kind: 'hosted', agent: UUID, tx: TX });
    expect(parseVerifyParams(`?agent=${UUID.toUpperCase()}&tx=${TX}`)).toEqual({ kind: 'hosted', agent: UUID, tx: TX });
    expect(parseVerifyParams(`?record=${encodeURIComponent(PUBLIC_RECORD)}`)).toEqual({ kind: 'public', ref: TX });
  });

  it('rejects uppercase or short tx, path-like agents, other hosts, repeated params and junk', () => {
    for (const q of [
      `?agent=${UUID}&tx=${TX.toUpperCase()}`,
      `?agent=${UUID}&tx=${TX.slice(1)}`,
      `?agent=../../admin&tx=${TX}`,
      `?agent=${UUID}&tx=${TX}&tx=${'cd'.repeat(32)}`,
      `?record=${encodeURIComponent(`https://evil.example/public/records/${TX}`)}`,
      `?record=${encodeURIComponent(`http://api.agentenact.io/public/records/${TX}`)}`,
      `?record=${encodeURIComponent(`https://api.agentenact.io/public/records/${TX}?x=1`)}`,
      `?record=${encodeURIComponent(`https://user@api.agentenact.io/public/records/${TX}`)}`,
      '?agent=&tx=',
      '',
    ]) expect(parseVerifyParams(q)).toBeNull();
  });

  it('builds the fetch url only from validated parts', () => {
    expect(recordUrl({ kind: 'hosted', agent: UUID, tx: TX })).toBe(`/a/${UUID}/records/${TX}`);
    expect(recordUrl({ kind: 'public', ref: TX })).toBe(PUBLIC_RECORD);
  });
});

describe('checkRecord', () => {
  const stub = (ok: boolean, wallet: { owner: string } | null = { owner: 'GOWNER' }): VerifierModule => ({
    verifyRecord: async () => ({ ok, checks: { signature: ok ? 'pass' : 'fail', settlement: 'pass', timing: 'pass', identity: ok ? 'pass' : 'skipped' }, ...(ok ? {} : { failure: { check: 'signature', reason: 'bad sig' } }) }),
    createStellarAdapter: () => ({ resolveIdentity: async () => wallet && { ...wallet, wallet: 'GAGENT' } }),
  });
  const record = { agent: { chain: 'stellar:testnet', address: 'GAGENT', agentId: '57' } };

  it('passes the four checks through and reads the owner from the registry', async () => {
    expect(await checkRecord(record, stub(true))).toMatchObject({ ok: true, owner: 'GOWNER', checks: { signature: 'pass' } });
  });

  it('ok only when signature, payment and timing all pass; a skipped one never counts as verified', async () => {
    const mod = stub(true);
    mod.verifyRecord = async () => ({ ok: true, checks: { signature: 'pass', settlement: 'skipped', timing: 'pass', identity: 'pass' } });
    expect((await checkRecord(record, mod)).ok).toBe(false);
    mod.verifyRecord = async () => ({ ok: true, checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'skipped' } });
    expect((await checkRecord({ agent: { chain: 'stellar:testnet', address: 'GAGENT' } }, mod)).ok).toBe(true);
    expect((await checkRecord(record, mod)).ok).toBe(false);
  });

  it('a failed check is not ok and carries the failure', async () => {
    expect(await checkRecord(record, stub(false))).toMatchObject({ ok: false, failure: { check: 'signature' } });
  });

  it('a network that never answers ends in an error after the time limit, never an endless check', async () => {
    const mod = stub(true);
    mod.verifyRecord = () => new Promise(() => {});
    await expect(checkRecord(record, mod, { timeoutMs: 50 })).rejects.toThrow('timeout');
  });

  it('an owner read that fails leaves the owner unknown, never invented', async () => {
    const mod = stub(true);
    mod.createStellarAdapter = () => ({ resolveIdentity: async () => { throw new Error('rpc down'); } });
    expect((await checkRecord(record, mod)).owner).toBeNull();
  });
});

describe('VerifyView', () => {
  const view = (s: VerifyState) => renderToStaticMarkup(createElement(VerifyView, { state: s, onRetry: () => {} })).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'");
  const found = (ok: boolean): VerifyState => ({
    phase: 'done',
    record: { agent: { address: 'GAGENTAGENTAGENT', agentId: '57' }, settlement: { ref: TX, payer: 'GPAYERPAYERPAYER', amount: '0.001', asset: 'USDC:GBBD' }, issuedAt: '2026-10-14T10:00:00.000Z' },
    result: { ok, checks: { signature: ok ? 'pass' : 'fail', settlement: 'pass', timing: 'pass', identity: 'pass' }, owner: 'GOWNEROWNEROWNER', ...(ok ? {} : { failure: { check: 'signature', reason: 'x' } }) },
  });

  it('never shows an amount in exponent notation', () => {
    const s = found(true);
    if (s.phase !== 'done') throw new Error('unreachable');
    s.record.settlement.amount = '0.0000001';
    const t = view(s);
    expect(t).toContain('0.0000001 USDC');
    expect(t).not.toMatch(/e-\d/);
  });

  it('a record that does not verify shows no payer, amount or agent from the record itself', () => {
    const t = view(found(false));
    expect(t).not.toContain('0.001');
    expect(t).not.toContain('GPAYER');
    expect(t).not.toContain('GAGENT');
  });

  it('every state reads in plain words and never claims the output is correct', () => {
    const states: VerifyState[] = [{ phase: 'loading' }, found(true), found(false), { phase: 'not_found' }, { phase: 'error' }, { phase: 'bad_link' }];
    for (const s of states) {
      const t = view(s);
      expect(t).not.toMatch(/\bcorrect\b|\baccurate\b|\btrue output\b/i);
    }
    expect(view(found(true))).toContain('Agent signature');
    expect(view(found(true))).toContain('This record verifies');
    expect(view(found(false))).toContain('This record does not verify');
    expect(view({ phase: 'not_found' })).toContain("We can't find this proof");
    expect(view({ phase: 'error' })).toContain('Try again in a minute');
    expect(view(found(true))).toContain('0.001 USDC');
    expect(view(found(true))).toMatch(/testnet/i);
  });

  it('lists what a verified record does not show, on every result', () => {
    for (const s of [found(true), found(false)]) {
      const t = view(s);
      expect(t).toContain('What a verified record does not show');
      expect(t).toContain('Which model or skill produced it');
    }
  });

  it('a payment lost to a testnet reset reads as unverifiable, not forged', () => {
    const s = found(false);
    if (s.phase !== 'done') throw new Error('unreachable');
    s.result = { ok: false, checks: { signature: 'pass', settlement: 'fail', timing: 'skipped', identity: 'skipped' }, owner: null, failure: { check: 'settlement', reason: 'history_unavailable' } };
    const t = view(s);
    expect(t).toContain('This record can no longer be checked');
    expect(t).toContain('History reset');
    expect(t).not.toContain('This record does not verify');
    expect(t).not.toContain('GPAYER');
  });
});

describe('watchAdapter and the pacer', () => {
  it('reports the steps in the order the verifier calls the adapter, passing the calls through unchanged', async () => {
    const { watchAdapter } = await import('../../src/lib/verify-record');
    const events: string[] = [];
    const a = watchAdapter(
      { chain: 'stellar', verify: async () => true, readSettlement: async () => [{ amount: '1' }], resolveIdentity: async () => ({ owner: 'G' }), sign: async () => 'x' },
      (e) => events.push(`${e.step}:${e.state}`),
    );
    expect(await a.verify()).toBe(true);
    expect(await a.readSettlement()).toEqual([{ amount: '1' }]);
    expect(await a.resolveIdentity()).toEqual({ owner: 'G' });
    expect(a.chain).toBe('stellar');
    expect(events).toEqual(['signature:running', 'signature:pass', 'settlement:running', 'settlement:pass', 'timing:running', 'timing:pass', 'identity:running', 'identity:pass']);
  });

  it('a missing payment or a bad signature shows as failed', async () => {
    const { watchAdapter } = await import('../../src/lib/verify-record');
    const events: string[] = [];
    const a = watchAdapter({ verify: async () => false, readSettlement: async () => [] }, (e) => events.push(`${e.step}:${e.state}`));
    await a.verify();
    await a.readSettlement();
    expect(events).toEqual(['signature:running', 'signature:fail', 'settlement:running', 'settlement:fail']);
  });

  it('applies updates in order, spaced by the gap, and idle waits for all of them', async () => {
    const { createPacer } = await import('../../src/lib/pace');
    const seen: [number, number][] = [];
    const t0 = Date.now();
    const p = createPacer(40);
    for (const i of [1, 2, 3]) p.push(() => seen.push([i, Date.now() - t0]));
    await p.idle();
    expect(seen.map(([i]) => i)).toEqual([1, 2, 3]);
    expect(seen[2]![1] - seen[0]![1]).toBeGreaterThanOrEqual(75);
  });
});
