import { describe, expect, it } from 'bun:test';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ENACTMENT_HEADER, encodeRecordHeader, type EnactmentRecord } from 'agentenact';
import { DELEGATION_HEADER } from 'agentenact/orchestrate';
import type { ServiceRow } from '../src/specs/index.js';
import { createServiceMcp } from '../src/signer/mcp.js';
import { parseSpec } from '../src/specs/schema.js';
import { minimalSpec } from './support/specs.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const SELLER = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'c'.repeat(64);
const svc: ServiceRow = {
  id: 's1', agentId: UUID, slug: 'summary', description: 'Summarise text.', priceUsdc: '0.0100000',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as never, outputSchema: { type: 'object' } as never,
  persona: 'p', skillBody: '', skills: [], tools: [], specVersion: 1, status: 'live', updatedAt: new Date(0),
};
const accepts = [{ scheme: 'exact', network: 'stellar:testnet', asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', amount: '100000', payTo: SELLER, maxTimeoutSeconds: 300, extra: {} }];
const paymentRequired = { x402Version: 2, resource: { url: `https://api.example/a/${UUID}/summary`, description: '', mimeType: 'application/json' }, accepts };
const record: EnactmentRecord = {
  v: '0.1', agent: { chain: 'stellar', address: SELLER, agentId: '13' }, input: { sha256: 'a'.repeat(64), mediaType: 'application/json' },
  output: { sha256: 'b'.repeat(64), mediaType: 'application/json', bytes: 20 }, settlement: { chain: 'stellar', ref: TX, payer: 'GPAYER', amount: '0.0100000', asset: 'USDC:G' },
  issuedAt: '2026-10-27T10:00:00Z', nonce: '33'.repeat(16), sig: { alg: 'ed25519', value: 'ff'.repeat(64) },
};
const payload = { x402Version: 2, resource: paymentRequired.resource, accepted: accepts[0], payload: { transaction: 'AAAA' } };
const settleHeader = encodePaymentResponseHeader({ success: true, transaction: TX, network: 'stellar:testnet', payer: 'GPAYER' } as never);

type Mode = 'paid' | 'refused' | 'record_failed' | 'loop';
function mcp(mode: Mode = 'paid', o: { agent?: { name: string; status: string } | null; live?: ServiceRow[] } = {}) {
  const seen: { body: string; payment: string | null; delegation: string | null }[] = [];
  const handle = async (req: Request, agentUuid: string, slug: string) => {
    expect([agentUuid, slug]).toEqual([UUID, 'summary']);
    const payment = req.headers.get('PAYMENT-SIGNATURE');
    seen.push({ body: await req.text(), payment, delegation: req.headers.get(DELEGATION_HEADER) });
    const json = (status: number, b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
    if (mode === 'loop') return json(508, { error: 'delegation_loop' });
    if (!payment) return json(402, paymentRequired, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired as never) });
    if (mode === 'refused') return json(402, { error: 'invalid_exact_stellar_payload_signature' });
    if (mode === 'record_failed') return json(500, { error: 'record_failed', transaction: TX }, { 'PAYMENT-RESPONSE': settleHeader });
    return json(200, { summary: 'short' }, { 'PAYMENT-RESPONSE': settleHeader, [ENACTMENT_HEADER]: encodeRecordHeader(record) });
  };
  const m = createServiceMcp({
    agent: async () => (o.agent === undefined ? { name: 'Summariser', status: 'active' } : o.agent),
    specs: { liveServices: async () => o.live ?? [svc] },
    endpoint: { handle, resourceUrl: (id, slug) => `https://api.example/a/${id}/${slug}` },
    version: '1',
  });
  const rpc = async (msg: unknown, headers: Record<string, string> = {}) => {
    const r = await m.handle(new Request(`https://api.example/a/${UUID}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(msg) }), UUID);
    return { status: r.status, body: r.status === 200 ? ((await r.json()) as { result?: Record<string, unknown>; error?: unknown }) : null };
  };
  const call = (args: unknown, meta?: Record<string, unknown>, headers?: Record<string, string>) =>
    rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'summary', arguments: args, ...(meta ? { _meta: meta } : {}) } }, headers).then((r) => r.body!.result!);
  return { rpc, call, seen };
}

describe('an agent as an MCP server', () => {
  it('lists one tool per live service, with its input schema and price', async () => {
    const { rpc } = mcp();
    const init = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    expect(init.body!.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'Summariser' } });
    const list = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body!.result as { tools: { name: string; description: string; inputSchema: unknown }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['summary']);
    expect(list.tools[0]!.description).toContain('Price: 0.01 USDC');
    expect(list.tools[0]!.inputSchema).toEqual(svc.inputSchema);
  });
  it('an unpaid call is the MCP form of a 402: isError with PaymentRequired as structured content and as text', async () => {
    const r = await mcp().call({ text: 'long' });
    expect(r).toMatchObject({ isError: true, structuredContent: { x402Version: 2, accepts } });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({ accepts });
  });
  it('a paid call goes through the paid endpoint with the encoded payment and exact body; the settlement and the record come back in _meta', async () => {
    const m = mcp();
    const r = await m.call({ text: 'long' }, { 'x402/payment': payload }, { [DELEGATION_HEADER]: 'abc' });
    expect(m.seen).toEqual([{ body: '{"text":"long"}', payment: encodePaymentSignatureHeader(payload as never), delegation: 'abc' }]);
    expect(r).toMatchObject({ structuredContent: { summary: 'short' }, _meta: { 'x402/payment-response': { success: true, transaction: TX }, 'agentenact/record': record } });
    expect(r.isError).toBeUndefined();
  });
  it('a refused payment answers PaymentRequired again with the reason', async () => {
    const r = await mcp('refused').call({ text: 'long' }, { 'x402/payment': payload });
    expect(r).toMatchObject({ isError: true, structuredContent: { accepts, error: 'invalid_exact_stellar_payload_signature' } });
    expect(await mcp('refused').call({ text: 'x' }, { 'x402/payment': 'not an object' })).toMatchObject({ isError: true, structuredContent: { error: 'invalid_payment' } });
  });
  it('after money moved, a failure still returns the settlement', async () => {
    expect(await mcp('record_failed').call({ text: 'long' }, { 'x402/payment': payload })).toMatchObject({
      isError: true, structuredContent: { error: 'record_failed', transaction: TX }, _meta: { 'x402/payment-response': { transaction: TX } },
    });
  });
  it('passes the paid endpoint\'s own refusals through (a loop is 508 there)', async () => {
    expect(await mcp('loop').call({ text: 'long' })).toMatchObject({ isError: true, structuredContent: { error: 'delegation_loop' } });
  });
  it('404s an agent that is not active or sells nothing', async () => {
    expect((await mcp('paid', { agent: null }).rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
    expect((await mcp('paid', { agent: { name: 'x', status: 'paused' } }).rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
    expect((await mcp('paid', { live: [] }).rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
  });
  it('no service may take the slug mcp (or records)', () => {
    const s = (slug: string) => minimalSpec({ services: [{ slug, description: 'd', price_usdc: '0.01', input_schema: { type: 'object' }, output_schema: { type: 'object' }, persona: 'p', skill_body: '', tools: [] }] });
    expect(() => parseSpec(s('mcp'))).toThrow();
    expect(() => parseSpec(s('records'))).toThrow();
    expect(() => parseSpec(s('summary'))).not.toThrow();
  });
});
