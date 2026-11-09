import { describe, expect, it } from 'bun:test';
import { canonicalJson, describeDoc, isSeal, matchDocument, readTx, sha256Hex } from '../../src/lib/verify-seal';
import { decisionBytes, sealBytes, type DecisionDocument, type SealDocument } from '../../../api/src/seals/format';

const AGENT = 'GDEZGPAO52GYY2BXAGVCCLGPPOWIX553GTRMJXXYLZDQYIPQI5FDA3OC';
const OTHER = 'GAYTGRAY4MHSZGEROVQKXHBWLI3LAB63MRQIMGPNK23HM6V7R65PYPFS';
const HASH = '2e3d853edbda307b338b78aa5b91eb29b79edf63ba2e7d3bca2dafc26d1c9a86';
const check: SealDocument = { v: 'ae.check/1', network: 'stellar:testnet', agent: AGENT, agentId: '131', at: '2026-11-04T15:02:09.512Z', held: false, reading: { xlm: 9.5, note: 'quiet' }, salt: '0123456789abcdef0123456789abcdef' };

describe('seal documents', () => {
  it('canonicalises exactly as the api writes a seal', () => {
    expect(canonicalJson(JSON.parse(sealBytes(check)))).toBe(sealBytes(check));
    const d: DecisionDocument = { v: 'ae.decision/1', network: 'stellar:testnet', agent: AGENT, agentId: null, at: check.at, runId: '123e4567-e89b-12d3-a456-426614174000', status: 'done', input: 'a'.repeat(64), output: null, steps: ['fetch_url', 'hire_agent'], txs: [{ network: 'stellar:testnet', tx: 'b'.repeat(64), usdc: '0.05', to: OTHER }], salt: check.salt };
    expect(canonicalJson(JSON.parse(decisionBytes(d)))).toBe(decisionBytes(d));
  });

  it('matches the exact bytes, a reformatted copy, one download entry or the whole day file', async () => {
    const bytes = sealBytes(check);
    const memo = await sha256Hex(bytes);
    const entry = { kind: 'check', runId: null, at: check.at, status: 'sent', digest: memo, tx: HASH, document: bytes };
    const other = { ...entry, digest: 'c'.repeat(64), document: sealBytes({ ...check, salt: 'f'.repeat(32) }) };
    for (const text of [bytes, JSON.stringify(check, null, 2), JSON.stringify(entry), JSON.stringify({ seals: [other, entry] })]) {
      const m = await matchDocument(text, memo, AGENT);
      expect(m.ok).toBe(true);
      if (m.ok) expect(m.doc.reading).toEqual({ xlm: 9.5, note: 'quiet' });
    }
  });

  it('refuses another seal, another agent, and text that is not json', async () => {
    const memo = await sha256Hex(sealBytes(check));
    expect(await matchDocument(sealBytes({ ...check, held: true }), memo, AGENT)).toEqual({ ok: false, reason: 'no_match' });
    expect(await matchDocument(sealBytes(check), memo, OTHER)).toEqual({ ok: false, reason: 'other_agent' });
    expect(await matchDocument('hello', memo, AGENT)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('describes a check and a decision in plain rows, and never shows the salt', () => {
    const c = describeDoc(check as never);
    expect(c.kind).toBe('A condition check');
    expect(c.rows).toContainEqual(['Condition held', 'No, quiet']);
    expect(JSON.stringify(describeDoc({ v: 'ae.future/9', salt: 's3cret', x: 1 }))).not.toContain('s3cret');
  });
});

describe('readTx', () => {
  // Horizon's real shapes: a fee-bumped seal (source = inner source, fee_account = sponsor, memo base64).
  const horizon = (tx: Record<string, unknown> | null, ops: string[] = ['bump_sequence']): typeof fetch =>
    (async (url: string) => {
      if (!tx) return new Response('{"status":404}', { status: 404 });
      if (String(url).includes('/operations')) return Response.json({ _embedded: { records: ops.map((type) => ({ type })) } });
      return Response.json(tx);
    }) as unknown as typeof fetch;
  const seal = { hash: HASH, source_account: AGENT, fee_account: OTHER, created_at: '2026-11-04T15:02:10Z', ledger: 5556178, memo_type: 'hash', memo: '+uAYfskiiM3gV4Aca565bqKI0Z7XsPi7/ZCIOQ++jjk=', successful: true, operation_count: 1, fee_charged: '200', max_fee: '200' };

  it('reads a fee-bumped seal: the agent as source, the memo as hex', async () => {
    const t = await readTx(HASH, horizon(seal));
    expect(t).toMatchObject({ source: AGENT, feeAccount: OTHER, memoHash: 'fae0187ec92288cde057801c6b9eb96ea288d19ed7b0f8bbfd9088390fbe8e39', ops: ['bump_sequence'] });
    expect(isSeal(t!)).toBe(true);
  });

  it('a payment, a text memo or a failed tx is not a seal; an unknown hash is null', async () => {
    expect(isSeal((await readTx(HASH, horizon(seal, ['payment'])))!)).toBe(false);
    expect(isSeal((await readTx(HASH, horizon({ ...seal, memo_type: 'text', memo: 'hi' })))!)).toBe(false);
    expect(isSeal((await readTx(HASH, horizon({ ...seal, successful: false })))!)).toBe(false);
    expect(await readTx(HASH, horizon(null))).toBeNull();
    expect(await readTx('nope', horizon(seal))).toBeNull();
  });
});
