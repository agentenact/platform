/**
 * A small syntax highlighter for the code samples on /create: TypeScript, JSON and shell. It splits the text into tokens
 * (comments, strings, numbers, keywords, function names, object keys) and returns HTML where every token is escaped first
 * and wrapped in a `tk-*` span; the colours are Night tokens in globals.css. Nothing from the text ever becomes markup, so a
 * value someone typed (a `<script>` in a text param) renders as text. No dependency, a few hundred bytes on the client.
 */
export type Lang = 'ts' | 'json' | 'sh';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const KEYWORDS = new Set([
  'import', 'from', 'export', 'const', 'let', 'var', 'await', 'async', 'return', 'function', 'new', 'if', 'else', 'for', 'of',
  'in', 'type', 'interface', 'as', 'typeof', 'throw', 'try', 'catch', 'true', 'false', 'null', 'undefined',
]);
const SH_COMMANDS = new Set(['bun', 'npm', 'npx', 'node', 'curl']);

type Kind = 'c' | 's' | 'n' | 'k' | 'f' | 'p' | '';

/** One regex per language; the named group that matched names the token. Unmatched text passes through as plain. */
const RULES: Record<Lang, RegExp> = {
  ts: /(?<c>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<s>'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(?<n>\b\d[\d_]*(?:\.\d+)?\b)|(?<w>[A-Za-z_$][\w$]*)/g,
  json: /(?<p>"(?:\\.|[^"\\\n])*"(?=\s*:))|(?<s>"(?:\\.|[^"\\\n])*")|(?<n>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<k>\btrue\b|\bfalse\b|\bnull\b)/g,
  sh: /(?<c>#[^\n]*)|(?<s>'[^'\n]*'|"(?:\\.|[^"\\\n])*")|(?<w>[A-Za-z_][\w@./-]*)/g,
};

function wordKind(lang: Lang, word: string, rest: string, lineStart: boolean): Kind {
  if (lang === 'sh') return lineStart && SH_COMMANDS.has(word) ? 'k' : '';
  if (KEYWORDS.has(word)) return 'k';
  if (/^\s*\(/.test(rest)) return 'f';
  if (/^\s*:/.test(rest)) return 'p';
  return '';
}

const span = (kind: Kind, text: string) => (kind ? `<span class="tk-${kind}">${escapeHtml(text)}</span>` : escapeHtml(text));

/** `code` as escaped HTML with token spans. */
export function highlight(code: string, lang: Lang): string {
  const re = new RegExp(RULES[lang].source, 'g');
  let out = '';
  let at = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += escapeHtml(code.slice(at, m.index));
    const g = m.groups ?? {};
    let kind: Kind = '';
    if (g.c !== undefined) kind = 'c';
    else if (g.p !== undefined) kind = 'p';
    else if (g.s !== undefined) kind = 's';
    else if (g.n !== undefined) kind = 'n';
    else if (g.k !== undefined) kind = 'k';
    else if (g.w !== undefined) {
      const before = code.slice(code.lastIndexOf('\n', m.index - 1) + 1, m.index);
      kind = wordKind(lang, m[0], code.slice(m.index + m[0].length), before.trim() === '');
    }
    out += span(kind, m[0]);
    at = m.index + m[0].length;
  }
  return out + escapeHtml(code.slice(at));
}
