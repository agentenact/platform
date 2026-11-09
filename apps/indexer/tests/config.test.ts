import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config.js';

const SECRET_URL = 'postgres://indexer:s3cretpw@db:5432/postgres';
const ok = { INDEXER_DATABASE_URL: SECRET_URL, PUBLIC_BASE_URL: 'https://agentenact.io' };
const G = 'GAYTGRAY4MHSZGEROVQKXHBWLI3LAB63MRQIMGPNK23HM6V7R65PYPFS';

describe('loadConfig', () => {
  it('requires INDEXER_DATABASE_URL and PUBLIC_BASE_URL', () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'https://agentenact.io' })).toThrow('INDEXER_DATABASE_URL');
    expect(() => loadConfig({ INDEXER_DATABASE_URL: SECRET_URL })).toThrow('PUBLIC_BASE_URL');
    expect(() => loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://agentenact.io/' })).toThrow('PUBLIC_BASE_URL');
    try {
      loadConfig({ INDEXER_DATABASE_URL: SECRET_URL, PUBLIC_BASE_URL: 'not a url s3cretpw' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('s3cretpw');
    }
  });

  it('defaults port 8080 and horizonRps 3', () => {
    const c = loadConfig(ok);
    expect(c.port).toBe(8080);
    expect(c.horizonRps).toBe(3);
    expect(c.sponsors).toEqual([]);
    expect(c.network).toBe('testnet');
    expect(c.registry).toBe('CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH');
    expect(c.usdc).toBe('USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  });

  it('bounds horizonRps to 1..10 and parses sponsors', () => {
    expect(() => loadConfig({ ...ok, INDEXER_HORIZON_RPS: '0' })).toThrow('INDEXER_HORIZON_RPS');
    expect(() => loadConfig({ ...ok, INDEXER_HORIZON_RPS: '11' })).toThrow('INDEXER_HORIZON_RPS');
    expect(loadConfig({ ...ok, INDEXER_HORIZON_RPS: '10', INDEXER_SPONSORS: ` ${G}, ${G} ,` }).sponsors).toEqual([G, G]);
  });

  it('payments come from our own Horizon polling unless set to agentkarma', () => {
    expect(loadConfig(ok)).toMatchObject({ paymentsSource: 'horizon', agentkarmaUrl: 'https://agentkarma.io' });
    expect(loadConfig({ ...ok, INDEXER_PAYMENTS_SOURCE: 'agentkarma', INDEXER_AGENTKARMA_URL: 'http://localhost:3737' })).toMatchObject({
      paymentsSource: 'agentkarma',
      agentkarmaUrl: 'http://localhost:3737',
    });
    expect(() => loadConfig({ ...ok, INDEXER_PAYMENTS_SOURCE: 'rpc' })).toThrow('INDEXER_PAYMENTS_SOURCE');
    expect(() => loadConfig({ ...ok, INDEXER_AGENTKARMA_URL: 'https://agentkarma.io/api' })).toThrow('INDEXER_AGENTKARMA_URL');
  });

  it('rejects a sponsor that is not a G address', () => {
    expect(() => loadConfig({ ...ok, INDEXER_SPONSORS: `${G},CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` })).toThrow('INDEXER_SPONSORS');
  });

  it('never reads SUPABASE_POSTGRES_PASSWORD or DATABASE_URL', () => {
    const c = loadConfig({ ...ok, SUPABASE_POSTGRES_PASSWORD: 'superpw', DATABASE_URL: 'postgres://other/x' });
    expect(c.databaseUrl).toBe(SECRET_URL);
    expect(JSON.stringify(c)).not.toContain('superpw');
    expect(JSON.stringify(c)).not.toContain('other/x');
    expect(() => loadConfig({ SUPABASE_POSTGRES_PASSWORD: 'superpw', DATABASE_URL: 'postgres://other/x', PUBLIC_BASE_URL: ok.PUBLIC_BASE_URL })).toThrow('INDEXER_DATABASE_URL');
  });

  it('accepts https origins and http only on localhost', () => {
    expect(loadConfig({ ...ok, PUBLIC_BASE_URL: 'http://localhost:8080' }).publicBaseUrl).toBe('http://localhost:8080');
    expect(loadConfig({ ...ok, PUBLIC_BASE_URL: 'https://a.example.com:8443' }).publicBaseUrl).toBe('https://a.example.com:8443');
  });

  it('rejects a public base URL with a path, a bad scheme or non-local http', () => {
    for (const bad of ['https://agentenact.io/a', 'http://agentenact.io', 'ftp://agentenact.io', 'https://agentenact.io?x=1', 'https://agentenact.io#f', 'https://u:p@agentenact.io', 'javascript:alert(1)']) {
      expect(() => loadConfig({ ...ok, PUBLIC_BASE_URL: bad })).toThrow('PUBLIC_BASE_URL');
    }
  });

  it('requires a postgres URL for the database, without echoing it', () => {
    expect(loadConfig({ ...ok, INDEXER_DATABASE_URL: 'postgresql://i:pw@db/x' }).databaseUrl).toBe('postgresql://i:pw@db/x');
    for (const bad of ['mysql://i:s3cretpw@db/x', 's3cretpw', 'http://db/x']) {
      let msg = '';
      try {
        loadConfig({ ...ok, INDEXER_DATABASE_URL: bad });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('INDEXER_DATABASE_URL');
      expect(msg).not.toContain('s3cretpw');
    }
  });
});
