/**
 * The alert email (UX audit rec. 2): the agent's own words wrapped in the same look as the sign-in emails (inline
 * styles, light paper, the seal), with what it checked and two links back. Model text is data: every character of it is
 * escaped, never linkified, and the plain-text part carries the same content. Neither link acts by itself; both open
 * panel pages (a run, a confirm page) because mail scanners fetch links. The mail only says what was read and when,
 * never that the reading is right.
 */
import { EMAILS_PER_DAY } from '../policy/index.js';
import { markdownEmailRows, plainMarkdown } from './markdown.js';

/** Real facts about the check that led to this mail. Every field is optional; a missing one is simply not shown. */
export interface AlertFacts {
  /** One plain sentence, e.g. "XLM moved −5.40% in the last hour". */
  reading?: string | null;
  /** When the reading was taken. */
  at?: Date | null;
  /** Checks the agent has made today (UTC). */
  checksToday?: number | null;
}

export interface AlertInput {
  agentName: string;
  agentId: string;
  runId?: string | undefined;
  appOrigin: string;
  /** The agent's own headline and words. */
  subject: string;
  body: string;
  facts?: AlertFacts | undefined;
  /**
   * The run's decision seal on Stellar testnet: `tx` once it landed, null while it is still on its way (the mail then
   * points at the agent page, where it shows up). Absent: no seal box.
   */
  seal?: { tx: string | null } | undefined;
  cap?: number;
}

const TX_HEX = /^[0-9a-f]{64}$/;
/** The public explorer page of a Stellar testnet transaction. */
export const testnetTxUrl = (tx: string) => `https://stellar.expert/explorer/testnet/tx/${tx}`;

export interface AlertEmail {
  subject: string;
  html: string;
  text: string;
}

const PAPER = '#f7f2ec';
const INK = '#2a2420';
const MUTED = '#6b625b';
const OXBLOOD = '#8e2a22';
const BOX = '#efe7de';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// eslint-disable-next-line no-control-regex
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

function when(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function checkedLines(f: AlertFacts | undefined): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (f.reading) out.push(oneLine(f.reading));
  if (f.at && !Number.isNaN(f.at.getTime())) out.push(`Read at ${when(f.at)}.`);
  if (typeof f.checksToday === 'number' && f.checksToday > 0) out.push(`${f.checksToday} ${f.checksToday === 1 ? 'check' : 'checks'} today.`);
  return out;
}

export function renderAlertEmail(i: AlertInput): AlertEmail {
  const name = oneLine(i.agentName);
  const headline = oneLine(i.subject);
  const cap = i.cap ?? EMAILS_PER_DAY;
  const agentPage = `${i.appOrigin}/dashboard/${encodeURIComponent(i.agentId)}`;
  const seeUrl = i.runId ? `${agentPage}?run=${encodeURIComponent(i.runId)}` : agentPage;
  const pauseUrl = `${i.appOrigin}/dashboard/pause?agent=${encodeURIComponent(i.agentId)}`;
  const subject = headline.toLowerCase().startsWith(name.toLowerCase()) ? headline : `${name}: ${headline}`;
  const lines = checkedLines(i.facts);
  const sealTx = i.seal?.tx && TX_HEX.test(i.seal.tx) ? i.seal.tx : null;
  const sealUrl = sealTx ? testnetTxUrl(sealTx) : null;
  const fine = `You get this because you made ${name} on AgentEnact. I send at most ${cap} emails a day. I tell you what I read and when; I cannot promise a reading is right. You can change what I watch, or pause me, from your agent page. Testnet, free.`;

  // The model writes markdown: drawn as headings, paragraphs and lists, every character escaped, no link made clickable.
  const paragraphs = markdownEmailRows(i.body, { muted: MUTED });
  const box = lines.length
    ? `<tr><td style="padding:6px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BOX};border-radius:12px;"><tr><td style="padding:14px 16px;">
<p style="margin:0 0 4px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">What I checked</p>
${lines.map((l) => `<p style="margin:0;font-size:14px;line-height:22px;">${esc(l)}</p>`).join('\n')}
</td></tr></table></td></tr>`
    : '';

  // The seal: what the agent decided, put on chain by the agent itself. A record of when and what, not that it is right.
  const sealBox = !i.seal
    ? ''
    : `<tr><td style="padding:0 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BOX};border-radius:12px;"><tr><td style="padding:14px 16px;">
<p style="margin:0 0 4px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Sealed on Stellar testnet</p>
${
  sealTx && sealUrl
    ? `<p style="margin:0 0 6px;font-size:14px;line-height:22px;">This run is sealed on chain by your agent.</p>
<p style="margin:0;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;"><a href="${esc(sealUrl)}" style="color:${INK};">${sealTx}</a></p>`
    : `<p style="margin:0;font-size:14px;line-height:22px;">Your agent is sealing this run on chain. The transaction shows on <a href="${esc(seeUrl)}" style="color:${INK};">your agent page</a> in a minute.</p>`
}
</td></tr></table></td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;font-family:${FONT};color:${INK};">
<tr><td style="padding-bottom:20px;"><img src="${i.appOrigin}/brand/seal-ink-96.png" width="48" height="48" alt="AgentEnact" style="display:block;border:0;"></td></tr>
<tr><td style="font-size:13px;line-height:18px;color:${MUTED};padding-bottom:6px;">From your agent, ${esc(name)}</td></tr>
<tr><td style="font-size:24px;line-height:30px;font-weight:700;padding-bottom:14px;">${esc(headline)}</td></tr>
${paragraphs}
${box}
${sealBox}
<tr><td style="padding-bottom:24px;"><a href="${esc(seeUrl)}" style="display:inline-block;background:${OXBLOOD};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;line-height:20px;padding:14px 24px;border-radius:999px;margin:0 8px 8px 0;">See what I saw</a><a href="${esc(pauseUrl)}" style="display:inline-block;background:${PAPER};color:${INK};text-decoration:none;font-size:16px;font-weight:600;line-height:20px;padding:12px 22px;border:2px solid ${INK};border-radius:999px;margin:0 0 8px;">Pause my agent</a></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:${MUTED};">${esc(fine)}</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    headline,
    '',
    plainMarkdown(i.body.trim()),
    ...(lines.length ? ['', 'What I checked', ...lines] : []),
    ...(i.seal ? ['', 'Sealed on Stellar testnet', sealTx && sealUrl ? `Transaction ${sealTx}\n${sealUrl}` : `Your agent is sealing this run on chain. The transaction shows on your agent page: ${seeUrl}`] : []),
    '',
    `See what I saw: ${seeUrl}`,
    `Pause my agent: ${pauseUrl}`,
    '',
    fine,
  ].join('\n');

  return { subject, html, text };
}
