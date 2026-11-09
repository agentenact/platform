import { describe, expect, it } from 'bun:test';
import { parsePasted, parseVerifyParams, verifySearch } from '../../src/lib/verify-params';
import { recentProofs } from '../../src/components/verify-start';
import type { FeedItem } from '../../src/lib/explore';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const TX = 'ab'.repeat(32);
const hosted = { kind: 'target', target: { kind: 'hosted', agent: UUID, tx: TX } };
const pub = { kind: 'target', target: { kind: 'public', ref: TX } };

describe('parsePasted', () => {
  it('opens proof links from any of the site hosts, with or without the scheme', () => {
    for (const s of [
      `https://agentenact.io/verify?agent=${UUID}&tx=${TX}`,
      `https://www.agentenact.io/verify/?agent=${UUID}&tx=${TX}`,
      `https://app.agentenact.io/verify?agent=${UUID}&tx=${TX}`,
      `agentenact.io/verify?agent=${UUID}&tx=${TX}`,
      `  https://agentenact.io/a/${UUID}/records/${TX}  `,
      `https://api.agentenact.io/a/${UUID.toUpperCase()}/records/${TX.toUpperCase()}`,
    ]) expect([s, parsePasted(s)]).toEqual([s, hosted as never]);
    expect(parsePasted(`https://agentenact.io/verify?record=${encodeURIComponent(`https://api.agentenact.io/public/records/${TX}`)}`)).toEqual(pub as never);
    expect(parsePasted(`https://api.agentenact.io/public/records/${TX}`)).toEqual(pub as never);
  });

  it('a bare hash or a stellar.expert testnet link opens the transaction (a shared record first, else the chain)', () => {
    const tx = { kind: 'target', target: { kind: 'tx', tx: TX } };
    expect(parsePasted(TX)).toEqual(tx as never);
    expect(parsePasted(TX.toUpperCase())).toEqual(tx as never);
    expect(parsePasted(`https://stellar.expert/explorer/testnet/tx/${TX}`)).toEqual(tx as never);
    expect(parsePasted(`stellar.expert/explorer/testnet/tx/${TX}`)).toEqual(tx as never);
    expect(parsePasted(`https://stellar.expert/explorer/public/tx/${TX}`).kind).toBe('invalid');
    expect(parseVerifyParams(`?tx=${TX}`)).toEqual({ kind: 'tx', tx: TX });
    expect(parseVerifyParams(`?tx=${TX}&x=1`)).toBeNull();
  });

  it('a pasted transaction signature is named as one, not verified', () => {
    expect(parsePasted('FyLPmvo4q/MnIYUX2vuM4Tv9PihpgTWqwU2rnp4qu8sLZSM+l4z/QaIOK71rV254yYhdpit6cEFU2fPDl8EQCQ==').kind).toBe('signature');
  });

  it('never lets a paste point the page at another host, scheme, port or credentials', () => {
    for (const s of [
      `https://evil.example/verify?agent=${UUID}&tx=${TX}`,
      `https://agentenact.io.evil.example/a/${UUID}/records/${TX}`,
      `http://agentenact.io/verify?agent=${UUID}&tx=${TX}`,
      `https://agentenact.io:8443/verify?agent=${UUID}&tx=${TX}`,
      `https://user@api.agentenact.io/public/records/${TX}`,
      `https://agentenact.io/public/records/${TX}`,
      `https://api.agentenact.io/public/records/${TX}?x=1`,
      `https://agentenact.io/verify?agent=../x&tx=${TX}`,
      `javascript:alert(1)`,
      TX.slice(2),
      'hello',
      '',
      '   ',
    ]) expect([s, parsePasted(s).kind]).toEqual([s, 'invalid']);
  });

  it('a whole record is checked in place; anything short of one is refused', () => {
    const record = { v: '0.2', agent: { chain: 'stellar:testnet', address: 'GAGENT', agentId: '57' }, settlement: { ref: TX, payer: 'GPAYER', amount: '0.01', asset: 'USDC:GBBD' }, issuedAt: '2026-11-04T10:00:00.000Z', sig: 'x' };
    const p = parsePasted(JSON.stringify(record, null, 2));
    expect(p.kind).toBe('record');
    if (p.kind === 'record') expect(p.record).toEqual(record as never); // passed to the verifier untouched
    expect(parsePasted('{"agent":{"address":"G"}}').kind).toBe('invalid');
    expect(parsePasted('{not json').kind).toBe('invalid');
    expect(parsePasted(JSON.stringify({ ...record, agent: { address: 'G', agentId: 57 } })).kind).toBe('invalid');
  });

  it('verifySearch round-trips through parseVerifyParams', () => {
    for (const t of [hosted.target, pub.target, { kind: 'tx', tx: TX }] as const) expect(parseVerifyParams(verifySearch(t as never))).toEqual(t as never);
  });
});

describe('recentProofs', () => {
  const item = (seq: number, over: Partial<FeedItem> = {}): FeedItem => ({
    seq, kind: 'paid', at: '2026-11-04T10:00:00Z', agentId: 7, builder: 'hosted', otherAgentId: null, amount: '0.01', label: null, selfPublished: false,
    link: { type: 'proof', ref: TX, agentUuid: UUID }, ...over,
  });

  it('keeps only paid lines with a proof, newest first as given, at most n, skipping a malformed ref', () => {
    const rows = recentProofs([
      item(1, { kind: 'registered', link: { type: 'registration', txHash: TX } }),
      item(2, { link: { type: 'payment', txHash: TX } }),
      item(3, { link: { type: 'proof', ref: 'nope', agentUuid: null } }),
      item(4),
      item(5, { link: { type: 'proof', ref: TX, agentUuid: null } }),
      item(6),
    ], 2);
    expect(rows.map((r) => r.item.seq)).toEqual([4, 5]);
    expect(rows[0]!.href).toBe(`/verify?agent=${UUID}&tx=${TX}`);
    expect(rows[1]!.href).toContain('/verify?record=');
  });
});
