import { describe, expect, it } from 'bun:test';
import { safeCause } from '../src/errors.js';

describe('safeCause', () => {
  it('keeps the class name and a SQLSTATE or a known library code, nothing else', () => {
    const pg = Object.assign(new Error('relation "app.secret_table" does not exist for user bob@example.com'), { name: 'PostgresError', errno: '42P01', code: 'ERR_POSTGRES_SERVER_ERROR', detail: 'x', cause: new Error('inner') });
    expect(safeCause(pg)).toEqual({ errName: 'PostgresError', errCode: '42P01' });
    expect(safeCause(Object.assign(new Error('read ECONNRESET 10.0.0.5:5432'), { code: 'ECONNRESET' }))).toEqual({ errName: 'Error', errCode: 'ECONNRESET' });
    expect(safeCause(Object.assign(new Error('x'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' }))).toEqual({ errName: 'Error', errCode: 'ERR_POSTGRES_CONNECTION_CLOSED' });
  });

  it('drops codes and names that do not pass the pattern, and never reads the message', () => {
    const e = Object.assign(new Error('secret SABC...'), { name: 'Bad Name: secret SABC', code: 'sk_live_abc 123', errno: 42 });
    const out = safeCause(e);
    expect(out).toEqual({ errName: 'unknown' });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(safeCause({ partial: { secret: 'S...' } })).toEqual({ errName: 'unknown' });
    expect(safeCause('a string with a secret')).toEqual({ errName: 'unknown' });
    expect(safeCause(null)).toEqual({ errName: 'unknown' });
    expect(Object.keys(safeCause(Object.assign(new Error('m'), { partial: { secret: 'S' } })))).toEqual(['errName']);
  });
});
