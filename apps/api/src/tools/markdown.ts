/**
 * The emails' reading of the markdown models write: the same parser as the agent page (apps/web/src/lib/markdown.ts;
 * apps/web/tests/markdown.test.ts holds both to one copy), drawn here as email HTML with inline styles. Every character
 * the model wrote is escaped; a link keeps only its words and the site's name, never an href.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'code'; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

// --- shared parser (identical in apps/web/src/lib/markdown.ts and apps/api/src/tools/markdown.ts) ---
const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`\n]+)`/))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
    } else if ((m = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/)) || (m = rest.match(/^__(?=\S)([\s\S]*?\S)__/))) {
      flush();
      out.push({ t: 'strong', c: inline(m[1]!) });
    } else if ((m = rest.match(/^\*(?=[^\s*])([^*\n]*?[^\s*])\*/)) || ((i === 0 || !/\w/.test(s[i - 1]!)) && (m = rest.match(/^_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/)))) {
      flush();
      out.push({ t: 'em', c: inline(m[1]!) });
    } else if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      const host = hostOf(m[2]!);
      buf += host && !m[1]!.includes(host) ? `${m[1]} (${host})` : m[1]!;
    } else {
      buf += s[i];
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

const BULLET = /^\s{0,3}[-*•+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line: string): Inline[][] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim()));

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[] } | null = null;
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', lines: para.map(inline) });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push(list.t === 'ul' ? { t: 'ul', items: list.items.map(inline) } : { t: 'ol', start: list.start, items: list.items.map(inline) });
    list = null;
  };
  // A fence still open when the text ends is a code block all the same (an answer being written, or cut off).
  let fence: { mark: string; code: string[] } | null = null;
  let table: { head: Inline[][]; rows: Inline[][][] } | null = null;
  const endTable = () => {
    if (table) blocks.push({ t: 'table', ...table });
    table = null;
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    if (fence) {
      if (raw.trim().startsWith(fence.mark) && raw.trim().replace(/[`~]/g, '') === '') {
        blocks.push({ t: 'code', v: fence.code.join('\n') });
        fence = null;
      } else fence.code.push(raw);
      continue;
    }
    const line = raw.replace(/\t/g, '  ');
    let m: RegExpMatchArray | null;
    if (table) {
      if (line.includes('|')) {
        table.rows.push(cells(line));
        continue;
      }
      endTable();
    }
    if ((m = line.match(FENCE))) {
      endPara();
      endList();
      fence = { mark: m[1]!, code: [] };
    } else if (line.includes('|') && TABLE_RULE.test(lines[n + 1] ?? '') && (lines[n + 1] ?? '').includes('-') && (lines[n + 1] ?? '').includes('|')) {
      endPara();
      endList();
      table = { head: cells(line), rows: [] };
      n++;
    } else if (!line.trim()) {
      endPara();
      endList();
    } else if (RULE.test(line) && !(list && /^\s{0,3}[-*]\s/.test(line))) {
      endPara();
      endList();
      blocks.push({ t: 'hr' });
    } else if ((m = line.match(HEADING))) {
      endPara();
      endList();
      blocks.push({ t: 'h', level: Math.min(3, m[1]!.length) as 1 | 2 | 3, c: inline(m[2]!) });
    } else if ((m = line.match(BULLET))) {
      endPara();
      if (list?.t !== 'ul') endList();
      list ??= { t: 'ul', start: 1, items: [] };
      list.items.push(m[1]!);
    } else if ((m = line.match(NUMBER))) {
      endPara();
      if (list?.t !== 'ol') endList();
      list ??= { t: 'ol', start: Number(m[1]), items: [] };
      list.items.push(m[2]!);
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      endList();
      para.push(line.trim());
    }
  }
  endPara();
  endList();
  endTable();
  if (fence) blocks.push({ t: 'code', v: (fence as { code: string[] }).code.join('\n') });
  return blocks;
}

/** The words alone: markers dropped, one block per paragraph. For one-line places (a feed row, a subject, plain-text mail). */
export function inlineText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('');
}
export function plainMarkdown(md: string): string {
  return parseMarkdown(md)
    .map((b) =>
      b.t === 'h' ? inlineText(b.c)
      : b.t === 'p' ? b.lines.map(inlineText).join('\n')
      : b.t === 'ul' ? b.items.map((i) => `• ${inlineText(i)}`).join('\n')
      : b.t === 'ol' ? b.items.map((i, n) => `${b.start + n}. ${inlineText(i)}`).join('\n')
      : b.t === 'code' ? b.v
      : b.t === 'table' ? [b.head, ...b.rows].map((r) => r.map(inlineText).join(' | ')).join('\n')
      : '———',
    )
    .join('\n\n');
}
// --- end shared parser ---

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function spans(c: Inline[]): string {
  return c
    .map((x) =>
      x.t === 'text' ? esc(x.v)
      : x.t === 'code' ? `<code style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;background:#efe7de;border-radius:4px;padding:1px 4px;">${esc(x.v)}</code>`
      : x.t === 'strong' ? `<strong>${spans(x.c)}</strong>`
      : `<em>${spans(x.c)}</em>`,
    )
    .join('');
}

/** Email rows (one `<tr>` per block) for a body the model wrote, styled like the rest of the mail. */
export function markdownEmailRows(md: string, o: { muted: string }): string {
  const row = (inner: string, pad = 14) => `<tr><td style="font-size:16px;line-height:24px;padding-bottom:${pad}px;">${inner}</td></tr>`;
  return parseMarkdown(md)
    .map((b) => {
      if (b.t === 'h') return row(`<p style="margin:0;font-size:17px;line-height:24px;font-weight:700;">${spans(b.c)}</p>`, 8);
      if (b.t === 'p') return row(`<p style="margin:0;">${b.lines.map(spans).join('<br>')}</p>`);
      if (b.t === 'code') return row(`<pre style="margin:0;padding:10px 12px;background:#efe7de;border-radius:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:19px;white-space:pre-wrap;word-break:break-word;">${esc(b.v)}</pre>`);
      if (b.t === 'table') {
        const cell = (tag: 'th' | 'td', c: Inline[]) => `<${tag} style="padding:6px 12px 6px 0;text-align:left;vertical-align:top;border-bottom:1px solid #e3dad0;">${spans(c)}</${tag}>`;
        const line = (tag: 'th' | 'td', r: Inline[][]) => `<tr>${r.map((c) => cell(tag, c)).join('')}</tr>`;
        return row(`<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;line-height:22px;">${line('th', b.head)}${b.rows.map((r) => line('td', r)).join('')}</table>`);
      }
      if (b.t === 'hr') return row(`<hr style="border:0;border-top:1px solid ${o.muted};opacity:.3;margin:0;">`);
      const tag = b.t === 'ul' ? 'ul' : 'ol';
      const start = b.t === 'ol' && b.start !== 1 ? ` start="${b.start}"` : '';
      return row(`<${tag}${start} style="margin:0;padding-left:22px;">${b.items.map((i) => `<li style="margin:0 0 6px;">${spans(i)}</li>`).join('')}</${tag}>`);
    })
    .join('\n');
}
