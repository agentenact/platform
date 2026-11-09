import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ASK_EXAMPLES, AskForm } from '../src/components/ask-form';

describe('ask form examples', () => {
  test('the server renders the first example, so hydration matches before the random pick', () => {
    expect(renderToStaticMarkup(createElement(AskForm))).toContain(`placeholder="${ASK_EXAMPLES[0]}"`);
  });
  test('every example reads upbeat: no falls, drops, crashes or dumps', () => {
    expect(ASK_EXAMPLES.length).toBeGreaterThan(5);
    for (const e of ASK_EXAMPLES) expect(e).not.toMatch(/\b(fall|falls|fell|drop|drops|dip|dips|crash|crashes|dump|dumps|plunge|tank|low)\b/i);
  });
});
