/**
 * A small, safe reading of the markdown models write (headings, paragraphs, bullet and numbered lists, bold, italic,
 * inline code, links). It parses to plain data, never to HTML, so nothing the model wrote is ever run or injected. Links
 * keep only their words and the site's name: model text is data, and a link in it is never made clickable.
 *
 * The same parser lives in apps/api/src/tools/markdown.ts (the emails); tests/markdown.test.ts holds both to one copy.
 * Pure TypeScript, no dependencies.
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

/**
 * An answer still being written, ready to read: a marker opened at the very end is closed (or hidden, if nothing follows
 * it yet), so `**bo` shows as bold and never as asterisks that later vanish. An open code fence needs nothing: the parser
 * reads it as a code block to the end. Only the last line can be unfinished. Never used on finished text.
 */
export function tidyPartial(md: string): string {
  const lines = md.split('\n');
  const fences = lines.filter((l) => /^\s{0,3}(`{3,}|~{3,})/.test(l)).length;
  if (fences % 2 === 1) return md;
  const last = lines.pop() ?? '';
  const lead = last.match(/^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)?/)?.[0] ?? '';
  let body = last.slice(lead.length);
  // A block marker with nothing after it, a bare `#` or `-`, is not a line yet.
  if (body === '' || /^(?:[-*+•]|#{1,6}|\d{1,3}[.)])$/.test(body)) return [...lines, lead.trim() ? lead : ''].join('\n').replace(/\n$/, '');
  // A link still arriving: its words alone (the parser never makes links clickable anyway).
  body = body.replace(/\[([^\]\n]*)(?:\](?:\([^)\n]*)?)?$/, '$1');
  if ((body.match(/`/g)?.length ?? 0) % 2 === 1) return [...lines, `${lead}${body}\``].join('\n');
  const count = (v: string) => {
    const bold = v.match(/\*\*/g)?.length ?? 0;
    return { bold, single: (v.replace(/\*\*/g, '').match(/\*/g)?.length ?? 0) };
  };
  const stars = body.match(/\*+$/)?.[0] ?? '';
  const bare = body.slice(0, body.length - stars.length);
  const before = count(bare);
  // Stars just typed that close nothing are hidden until there is a word after them.
  if (stars && !(stars.length >= 2 && before.bold % 2 === 1) && !(stars.length === 1 && before.single % 2 === 1)) body = bare;
  const now = count(body);
  if (now.single % 2 === 1) body = `${body.trimEnd()}*`;
  if (now.bold % 2 === 1) body = `${body.trimEnd()}**`;
  return [...lines, `${lead}${body}`].join('\n');
}

/** One line for a feed row: the words, no markers, whitespace folded. */
export const oneLineMarkdown = (md: string): string => plainMarkdown(md).replace(/\s+/g, ' ').trim();
