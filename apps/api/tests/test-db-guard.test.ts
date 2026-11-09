import { describe, expect, it } from 'bun:test';
import { TEST_DB_HOSTS, TEST_DB_NAME, assertSafeTestDbUrl } from './support/db.js';

describe('test database guard', () => {
  it('accepts only the dedicated local test database', () => {
    const ok = `postgres://postgres:test@localhost:55439/${TEST_DB_NAME}`;
    expect(assertSafeTestDbUrl(ok)).toBe(ok);
  });

  it('refuses a missing url, a remote host, or any other database name', () => {
    expect(() => assertSafeTestDbUrl(undefined)).toThrow(/not set/);
    expect(() => assertSafeTestDbUrl(`postgres://u:p@db.example.com:5432/${TEST_DB_NAME}`)).toThrow(/localhost/);
    expect(() => assertSafeTestDbUrl('postgres://postgres:test@localhost:54329/postgres')).toThrow(TEST_DB_NAME);
  });

  it('accepts the in-network host', () => {
    const ok = `postgres://postgres:test@servel-infra-agentenact-cloud-test-postgres:5432/${TEST_DB_NAME}`;
    expect(TEST_DB_HOSTS).toContain('servel-infra-agentenact-cloud-test-postgres');
    expect(assertSafeTestDbUrl(ok)).toBe(ok);
  });

  it('still refuses another host', () => {
    expect(() => assertSafeTestDbUrl(`postgres://u:p@db.example.com:5432/${TEST_DB_NAME}`)).toThrow(/must point at/);
  });

  it('still refuses another database name', () => {
    expect(() =>
      assertSafeTestDbUrl('postgres://postgres:test@servel-infra-agentenact-cloud-test-postgres:5432/postgres'),
    ).toThrow(TEST_DB_NAME);
  });

  it('refuses query parameters that could override the host or database', () => {
    expect(() => assertSafeTestDbUrl(`postgres://postgres:test@localhost:55439/${TEST_DB_NAME}?host=evil`)).toThrow(
      /query parameters/,
    );
  });
});
