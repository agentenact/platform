import type { DraftData } from '../../src/lib/draft-types';

/** A full 56-character account address, to prove it never reaches the screen. */
export const G = `G${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 51)}WXYZ`;

export const sampleDraft = (over: Partial<DraftData> = {}): DraftData => ({
  name: 'XLM watcher',
  sentence: ['Every ', { param: 'every' }, ' I check the price. If it falls ', { param: 'drop' }, ' within an hour, I ', { param: 'how' }, ' you.'],
  params: [
    { id: 'every', label: 'How often', kind: 'choice', options: [{ label: '5 minutes', value: 300 }, { label: 'hour', value: 3600 }], value: 300 },
    { id: 'drop', label: 'Drop', kind: 'number', value: 5, min: 1, max: 50, unit: '%' },
    { id: 'how', label: 'How', kind: 'text', value: 'email' },
  ],
  bindings: [
    { param: 'every', path: '/triggers/0/every_s' },
    { param: 'drop', path: '/triggers/0/params/drop' },
    { param: 'how', path: '/delivery/email' },
  ],
  spec: { persona: 'I am calm.', system_prompt: 'Watch the price.', skills: [{ name: 'digest', description: 'd', body: 'Write a digest.' }] },
  ...over,
});

