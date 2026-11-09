import { describe, expect, test } from 'bun:test';
import { PUBLIC } from '../src/lib/public-config';
import { apiBaseUrl } from '../src/server/api';

describe('apiBaseUrl', () => {
  test('falls back to the public api url', () => {
    expect(apiBaseUrl({})).toBe(PUBLIC.apiUrl);
    expect(apiBaseUrl({ API_INTERNAL_URL: '  ' })).toBe(PUBLIC.apiUrl);
  });
  test('uses the internal url, without a trailing slash', () => {
    expect(apiBaseUrl({ API_INTERNAL_URL: 'http://agentenact-api:8080/' })).toBe('http://agentenact-api:8080');
  });
  test('refuses anything but http(s)', () => {
    expect(() => apiBaseUrl({ API_INTERNAL_URL: 'file:///etc/passwd' })).toThrow();
    expect(() => apiBaseUrl({ API_INTERNAL_URL: 'not a url' })).toThrow();
  });
});
