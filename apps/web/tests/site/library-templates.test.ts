import { describe, expect, it } from 'bun:test';
import { LIBRARY_TEMPLATES } from '../../src/lib/library-templates';
import { templateSnippet } from '../../src/lib/snippets';
import { TEMPLATES, fromTemplate, getTemplate } from 'agentenact/templates';

describe('library templates on /create', () => {
  it('mirror the library: ids, titles, summaries, prices, output types and params', () => {
    expect<string[]>(LIBRARY_TEMPLATES.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    for (const t of LIBRARY_TEMPLATES) {
      const lib = getTemplate(t.id)!;
      expect<string[]>([t.title, t.summary, t.price, t.output]).toEqual([lib.title, lib.summary, lib.defaults.price, lib.output.mediaType]);
      expect(Object.keys(t.example).sort()).toEqual(Object.keys(lib.params ?? {}).sort());
    }
  });

  it('show params the library accepts', () => {
    for (const t of LIBRARY_TEMPLATES) {
      const agent = fromTemplate(getTemplate(t.id)!, { params: { ...t.example }, model: async () => 'ok' });
      expect(agent.agentUri.startsWith('data:')).toBe(true);
    }
  });

  it('snippets name the template and its params', () => {
    const s = templateSnippet(LIBRARY_TEMPLATES[1]);
    expect(s).toContain("getTemplate('translate')");
    expect(s).toContain('to: "English"');
  });
});
