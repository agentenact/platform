import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const registry: { name: string; element: ReactElement }[] = [];

/** Each later task registers the screens it adds so the banned-words scan covers them. */
export function registerScreen(name: string, element: ReactElement): void {
  registry.push({ name, element });
}

export function renderScreens(): { name: string; html: string }[] {
  return registry.map(({ name, element }) => ({ name, html: renderToStaticMarkup(element) }));
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Remove every element carrying data-advanced (with its subtree). */
export function stripAdvanced(html: string): string {
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let out = '';
  let last = 0;
  let skipDepth = 0; // > 0 while inside a data-advanced subtree
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const [whole, closing, name, attrs, selfClose] = m as unknown as [string, string, string, string, string];
    if (skipDepth === 0) out += html.slice(last, m.index);
    last = m.index + whole.length;
    const isVoid = VOID.has(name.toLowerCase()) || selfClose === '/';
    if (closing) {
      if (skipDepth > 0) skipDepth--;
      else out += whole;
    } else if (skipDepth > 0) {
      if (!isVoid) skipDepth++;
    } else if (/\sdata-advanced(\s|=|$)/.test(` ${attrs}`)) {
      if (!isVoid) skipDepth = 1;
    } else out += whole;
  }
  if (skipDepth === 0) out += html.slice(last);
  return out;
}

/** Visible text of markup: tags dropped, entities for the few characters React escapes decoded. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}
