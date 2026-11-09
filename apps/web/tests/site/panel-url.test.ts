import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { builderUrl, PANEL, panelUrl, templateUrl } from '../../src/lib/panel-url';
import { FEATURED, ReadyAgents } from '../../src/components/ready-agents';
import { TEMPLATES } from '../../src/lib/templates';
import { Hero } from '../../src/components/hero';

describe('panelUrl', () => {
  it('encodes, trims, caps at 500 characters and falls back to the panel root for blank input', () => {
    expect(panelUrl('  Tell me when XLM falls 5% & more  ')).toBe(`${PANEL}/draft?prompt=Tell+me+when+XLM+falls+5%25+%26+more`);
    const long = 'a'.repeat(600);
    expect(new URL(panelUrl(long), 'https://base.test').searchParams.get('prompt')).toHaveLength(500);
    expect(panelUrl('')).toBe(`${PANEL}/create`);
    expect(panelUrl(' \n\t ')).toBe(`${PANEL}/create`);
  });

  it('stays in this app (a relative /draft path) and carries nothing but the prompt', () => {
    expect(PANEL).toBe('');
    expect(panelUrl('x').startsWith('/draft?')).toBe(true);
    expect(panelUrl('x')).not.toContain('://');
    const u = new URL(panelUrl('x'), 'https://base.test');
    expect(u.origin).toBe('https://base.test');
    expect([...u.searchParams.keys()]).toEqual(['prompt']);
    expect(panelUrl('x')).not.toContain('agentenact.io/#');
  });
});

describe('Hero', () => {
  const html = renderToStaticMarkup(createElement(Hero, { recordHash: 'ab'.repeat(32) }));
  const text = html.replace(/<[^>]+>/g, ' ');
  it('keeps the #create anchor, one prompt box and one submit', () => {
    expect(html).toContain('id="create"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain('maxLength="500"');
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(text).toContain('Free to try. You see your agent before you sign up.');
  });
  it('asks for no wallet on the main path', () => {
    expect(text).not.toMatch(/Freighter|secret|wallet/i);
  });
});

describe('ReadyAgents', () => {
  const html = renderToStaticMarkup(createElement(ReadyAgents));
  const text = html.replace(/<[^>]+>/g, ' ');
  it('links the featured ready agents to them in the builder, then all of them and the developer path (the code view)', () => {
    for (const t of TEMPLATES.filter((x) => FEATURED.includes(x.id))) {
      expect(text).toContain(t.title);
      expect(html).toContain(`href="${builderUrl({ template: t.id })}"`);
    }
    expect(builderUrl({ template: 'xlm-drop' })).toBe(`${PANEL}/create?template=xlm-drop`);
    expect(templateUrl('xlm-drop')).toBe(`${PANEL}/draft?template=xlm-drop`);
    expect(html).toContain('href="/create?view=code"');
    expect(html).toContain('href="/create"');
  });
  it('offers a PIN or password and keeps Face ID optional', () => {
    expect(text).toContain('a PIN or password works, Face ID is optional');
    expect(text).not.toMatch(/email and Face ID/);
  });
});
