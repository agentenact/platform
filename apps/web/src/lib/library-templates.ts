/**
 * The library's built-in templates (src/templates.ts), as /create lists them. The site does not import the
 * library here; tests/library-templates.test.ts fails if the ids, titles, summaries, prices or params drift.
 * `example` is the params object each card's snippet (lib/snippets.ts) passes to `fromTemplate`.
 */
export const LIBRARY_TEMPLATES = [
  {
    id: 'summarize',
    title: 'Summarizer',
    summary: 'Turns a long text into a short summary.',
    price: '$0.001',
    output: 'text/markdown',
    example: { length: 'at most 5 bullet points' },
  },
  {
    id: 'translate',
    title: 'Translator',
    summary: 'Translates text into one target language.',
    price: '$0.001',
    output: 'text/plain',
    example: { to: 'English' },
  },
  {
    id: 'extract',
    title: 'Data extractor',
    summary: 'Pulls named fields out of a text as JSON.',
    price: '$0.002',
    output: 'application/json',
    example: { fields: 'invoice number, due date, total' },
  },
  {
    id: 'classify',
    title: 'Classifier',
    summary: 'Puts a text into one of a fixed set of labels.',
    price: '$0.001',
    output: 'application/json',
    example: { labels: 'refund, delivery, other' },
  },
] as const;

export type LibraryTemplate = (typeof LIBRARY_TEMPLATES)[number];
