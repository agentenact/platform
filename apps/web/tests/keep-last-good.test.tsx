import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentError, AgentScreen } from '../src/components/agent-screen';
import { KeepLastGood } from '../src/components/keep-last-good';
import { copy } from '../src/copy';
import { nextShown } from '../src/lib/keep-last-good';
import type { AgentLoad } from '../src/server/agent-data';
import { feed, overview, AGENT_ID, NOW } from './support/agent';
import { textOf } from './support/screens';

describe('a refresh that fails keeps the last good page', () => {
  test('the first good render is shown and remembered', () => {
    expect(nextShown(null, true, 'A')).toEqual({ shown: 'A', good: 'A', stale: false });
  });

  test('a later failure shows the remembered page, with the quiet note, and remembers it still', () => {
    const first = nextShown(null, true, 'A');
    expect(nextShown(first.good, false, null)).toEqual({ shown: 'A', good: 'A', stale: true });
  });

  test('the next good render replaces the page and clears the note', () => {
    expect(nextShown('A', true, 'B')).toEqual({ shown: 'B', good: 'B', stale: false });
  });

  test('a failure with nothing remembered is the error screen (a hard failure on first load)', () => {
    expect(nextShown(null, false, null)).toEqual({ shown: null, good: null, stale: false });
  });
});

describe('KeepLastGood', () => {
  const error = createElement(AgentError);

  test('a good page renders its children and no note', () => {
    const html = renderToStaticMarkup(createElement(KeepLastGood, { ok: true, error }, createElement('p', { id: 'page' }, 'the page')));
    expect(html).toContain('the page');
    expect(html).not.toContain('data-refresh-note');
    expect(html).not.toContain('data-agent-error');
  });

  test('a first load that failed shows the error screen', () => {
    const html = renderToStaticMarkup(createElement(KeepLastGood, { ok: false, error }, null));
    expect(html).toContain('data-agent-error');
    expect(html).not.toContain('data-refresh-note');
  });

  test('the quiet note is plain words', () => {
    expect(copy.agent.refreshFailed).toBe("Couldn't refresh just now. Showing what we had.");
  });
});

describe('AgentScreen', () => {
  const ready = (): AgentLoad => ({ kind: 'ready', id: AGENT_ID, overview: overview(), feed: feed() });

  test('a good load is the page, inside the keeper', async () => {
    const html = renderToStaticMarkup(await AgentScreen({ id: AGENT_ID, load: async () => ready(), now: NOW }));
    expect(textOf(html).replace(/\s+/g, ' ')).toContain('288 checks. Nothing worth your time.');
    expect(html).not.toContain('data-agent-error');
  });

  test('an error on the first load is still the error screen', async () => {
    const html = renderToStaticMarkup(await AgentScreen({ id: AGENT_ID, load: async () => ({ kind: 'error' }) }));
    expect(html).toContain('data-agent-error');
  });
});
