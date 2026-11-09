/**
 * Delivery to the owner (spec §2.6, §7): email through the Resend HTTP API (`POST /emails`, Bearer key;
 * docs checked 2026-10-05) to the owner's address only (plain text, plus HTML when given); webhooks to the owner's URL only,
 * signed with the agent's HMAC secret. Both through safeFetch. Errors are fixed codes.
 */
import { createHmac } from 'node:crypto';
import { toolError } from './errors.js';
import type { SafeFetch } from './safe-fetch.js';

export const RESEND_URL = 'https://api.resend.com/emails';

export interface Delivery {
  /** `html`, when given, is sent beside `text` as the multipart alternative. */
  email(to: string, subject: string, text: string, idempotencyKey?: string, html?: string): Promise<{ id: string }>;
  webhook(url: string, agentId: string, payload: unknown): Promise<{ status: number }>;
}

/** Hex HMAC-SHA256 over `${timestamp}.${body}`, keyed by the agent's hex secret. Owners verify with the same. */
export function signWebhookBody(secretHex: string, timestamp: number, body: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`${timestamp}.${body}`).digest('hex');
}

export function createDelivery(o: { safeFetch: SafeFetch; resendKey: string; mailFrom: string; webhookSecret: (agentId: string) => string | Promise<string>; now?: () => number }): Delivery {
  const now = o.now ?? Date.now;
  return {
    async email(to, subject, text, idempotencyKey, html) {
      const r = await o.safeFetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${o.resendKey}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ from: o.mailFrom, to: [to], subject, text, ...(html ? { html } : {}) }),
      });
      if (r.status !== 200) throw toolError('email_failed');
      try {
        const j = JSON.parse(new TextDecoder().decode(r.body)) as { id?: unknown };
        return { id: String(j.id ?? '') };
      } catch {
        return { id: '' };
      }
    },

    async webhook(url, agentId, payload) {
      const secret = await o.webhookSecret(agentId);
      const t = now();
      const ts = Math.floor(t / 1000);
      const body = JSON.stringify({ agentId, sentAt: new Date(t).toISOString(), payload });
      const r = await o.safeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agentenact-timestamp': String(ts), 'x-agentenact-signature': `sha256=${signWebhookBody(secret, ts, body)}` },
        body,
        maxBytes: 64 * 1024,
        // A redirect would continue as a bodiless, unsigned GET and still answer 2xx: treat it as a failure.
        maxRedirects: 0,
      });
      if (r.status < 200 || r.status >= 300) throw toolError('webhook_failed');
      return { status: r.status };
    },
  };
}
