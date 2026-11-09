/**
 * Each hosted agent as an MCP server (MCP plan step 5): `POST /a/<uuid>/mcp`, stateless Streamable HTTP, one tool per
 * live paid service. Payment is x402 over MCP (x402 spec `transports-v2/mcp.md`, read 2026-10-27):
 *   - a call without `_meta["x402/payment"]` gets `isError: true` with the PaymentRequired object (structuredContent
 *     and the same JSON as text), the MCP form of a 402;
 *   - a call with it is paid: the result carries `_meta["x402/payment-response"]` (the settlement) and
 *     `_meta["agentenact/record"]` (the Enactment Record);
 *   - a refused or failed payment answers PaymentRequired again with the reason in `error`.
 *
 * Every call goes through the SAME paid endpoint as `POST /a/<uuid>/<slug>` (signer/serve.ts), as a request built here:
 * body = JSON.stringify(arguments), PAYMENT-SIGNATURE = the encoded payload, AgentEnact-Delegation passed through.
 * So the money order (verify → run → settle → sign → send), the caps, the loop refusal and the stored record are
 * exactly the HTTP route's. The record's input hash covers those body bytes. Nothing here routes money: the payer
 * pays the agent directly through the facilitator, as on the HTTP route.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { decodeRecordHeader, ENACTMENT_HEADER } from 'agentenact';
import { createMcpServer, handleMcpHttp, type McpRawTool, type McpToolResult } from 'agentenact/mcp';
import { DELEGATION_HEADER } from 'agentenact/orchestrate';
import type { ServiceRow, Specs } from '../specs/index.js';
import type { ServiceEndpoint } from './serve.js';
import { priceOf } from './serve.js';

export const MCP_SLUG = 'mcp';
const MAX_MCP_BODY = 128 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }];
const errorResult = (structured: Record<string, unknown>, meta?: Record<string, unknown>): McpToolResult => ({
  content: text(structured),
  structuredContent: structured,
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});

export interface ServiceMcp {
  handle(req: Request, agentUuid: string): Promise<Response>;
}

export function createServiceMcp(d: {
  agent: (agentUuid: string) => Promise<{ name: string; status: string } | null>;
  specs: Pick<Specs, 'liveServices'>;
  endpoint: Pick<ServiceEndpoint, 'handle' | 'resourceUrl'>;
  version: string;
}): ServiceMcp {
  function tool(svc: ServiceRow, agentUuid: string, delegation: string | null): McpRawTool {
    const url = d.endpoint.resourceUrl(agentUuid, svc.slug);
    const call = (body: string, payment: string | null) =>
      d.endpoint.handle(
        new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(payment ? { 'PAYMENT-SIGNATURE': payment } : {}),
            ...(delegation ? { [DELEGATION_HEADER]: delegation } : {}),
          },
          body,
        }),
        agentUuid,
        svc.slug,
      );
    /** The PaymentRequired object of an unpaid call, with `error` set when a payment was refused. */
    const paymentRequired = async (res: Response, body: string, reason?: string): Promise<McpToolResult> => {
      let header = res.headers.get('PAYMENT-REQUIRED');
      if (!header) header = (await call(body, null)).headers.get('PAYMENT-REQUIRED');
      if (!header) return errorResult({ error: reason ?? 'payments_unavailable' });
      const pr = decodePaymentRequiredHeader(header) as unknown as Record<string, unknown>;
      return errorResult(reason ? { ...pr, error: reason } : pr);
    };

    return {
      name: svc.slug,
      description: `${svc.description} Price: ${priceOf(svc.priceUsdc)} USDC on Stellar testnet, paid with x402 (_meta "x402/payment"). The answer carries an Enactment Record in _meta "agentenact/record"; its input hash covers JSON.stringify(arguments).`,
      inputSchema: svc.inputSchema as Record<string, unknown>,
      annotations: { title: svc.slug, readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async call(args, ctx) {
        const body = JSON.stringify(args ?? {});
        const raw = ctx.meta?.['x402/payment'];
        let payment: string | null = null;
        if (raw !== undefined) {
          if (!isObj(raw)) return paymentRequired(new Response(null), body, 'invalid_payment');
          try {
            payment = encodePaymentSignatureHeader(raw as never);
          } catch {
            return paymentRequired(new Response(null), body, 'invalid_payment');
          }
        }
        const res = await call(body, payment);
        const settled = res.headers.get('PAYMENT-RESPONSE');
        const settlement = settled ? (decodePaymentResponseHeader(settled) as unknown as Record<string, unknown>) : null;
        if (res.status === 402) {
          if (!payment) return paymentRequired(res, body);
          const refused = (await res.json().catch(() => null)) as { error?: unknown } | null;
          return paymentRequired(res, body, typeof refused?.error === 'string' ? refused.error : 'payment_refused');
        }
        if (res.status !== 200) {
          const err = await res.json().catch(() => ({ error: `status_${res.status}` }));
          // After money moved (a record failure), the settlement still goes back to the payer.
          return errorResult(isObj(err) ? err : { error: `status_${res.status}` }, settlement ? { 'x402/payment-response': settlement } : undefined);
        }
        const out = await res.text();
        let structured: unknown = null;
        try {
          structured = JSON.parse(out);
        } catch {
          // a non-JSON answer stays text
        }
        const header = res.headers.get(ENACTMENT_HEADER);
        let record: unknown = null;
        try {
          record = header ? decodeRecordHeader(header) : null;
        } catch {
          record = null;
        }
        return {
          content: text(out),
          ...(isObj(structured) ? { structuredContent: structured } : {}),
          _meta: { ...(settlement ? { 'x402/payment-response': settlement } : {}), ...(record ? { 'agentenact/record': record } : {}) },
        };
      },
    };
  }

  return {
    async handle(req, agentUuid) {
      const agent = await d.agent(agentUuid);
      const live = agent && agent.status === 'active' ? await d.specs.liveServices(agentUuid) : [];
      if (!agent || live.length === 0) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const delegation = req.headers.get(DELEGATION_HEADER);
      const server = createMcpServer({
        name: agent.name.slice(0, 60) || 'agent',
        version: d.version,
        tools: live.map((s) => tool(s, agentUuid, delegation)),
        instructions:
          'Paid services of one AgentEnact agent. Each tool is paid per call in USDC with x402 over MCP; the answer carries an ' +
          'Enactment Record that proves who produced it and that it was paid for, never that it is correct.',
      });
      return handleMcpHttp(server, req, { maxBytes: MAX_MCP_BODY });
    },
  };
}
