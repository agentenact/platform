import { describe, expect, test } from 'bun:test';
import { oldHostRedirect } from '../src/lib/old-host';

const NEW = 'https://agentenact.io';

describe('app.agentenact.io after the cutover', () => {
  test('every path and query moves to the same place on agentenact.io', () => {
    expect(oldHostRedirect('app.agentenact.io', '/connect', '', NEW)).toBe('https://agentenact.io/connect');
    expect(oldHostRedirect('app.agentenact.io', '/draft', '?h=abc&template=xlm-drop', NEW)).toBe('https://agentenact.io/draft?h=abc&template=xlm-drop');
    expect(oldHostRedirect('APP.agentenact.io:443', '/', '', NEW)).toBe('https://agentenact.io/');
    expect(oldHostRedirect('app.agentenact.io', '/dashboard/chat', '', NEW)).toBe('https://agentenact.io/dashboard/chat');
  });
  test('the old /agent paths land in one hop', () => {
    expect(oldHostRedirect('app.agentenact.io', '/agent', '?run=r1', NEW)).toBe('https://agentenact.io/dashboard?run=r1');
    expect(oldHostRedirect('app.agentenact.io', '/agent/pause', '?agent=a1', NEW)).toBe('https://agentenact.io/dashboard/pause?agent=a1');
  });
  test('nothing moves before the cutover (the old host is still the origin), on the new host, or on staging', () => {
    expect(oldHostRedirect('app.agentenact.io', '/connect', '', 'https://app.agentenact.io')).toBeNull();
    expect(oldHostRedirect('agentenact.io', '/connect', '', NEW)).toBeNull();
    expect(oldHostRedirect('staging.agentenact.io', '/', '', 'https://staging.agentenact.io')).toBeNull();
    expect(oldHostRedirect(null, '/', '', NEW)).toBeNull();
  });
});
