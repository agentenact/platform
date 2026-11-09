import { z } from 'zod';

/** Testnet chain constants, pinned in code on purpose: they are never read from env. */
export const CHAIN = {
  network: 'testnet',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  registry: 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH',
  usdc: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
} as const;

export interface IndexerConfig {
  port: number;
  databaseUrl: string;
  network: 'testnet';
  horizonUrl: string;
  rpcUrl: string;
  registry: string;
  usdc: string;
  publicBaseUrl: string;
  sponsors: string[];
  horizonRps: number;
  /** Where the payments stage reads from: our own Horizon polling, or AgentKarma's payment feed. */
  paymentsSource: 'horizon' | 'agentkarma';
  agentkarmaUrl: string;
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https (or http on localhost) origin only: no path, query, fragment or credentials, no trailing slash. */
function isOrigin(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  const schemeOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
  return schemeOk && u.pathname === '/' && !v.endsWith('/') && !u.search && !u.hash && !u.username && !u.password;
}

const schema = z.object({
  INDEXER_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL'),
  PUBLIC_BASE_URL: z.string().refine(isOrigin, 'must be an https origin (http only for localhost) with no path'),
  INDEXER_SPONSORS: z.string().optional(),
  INDEXER_HORIZON_RPS: z.coerce.number().int().min(1).max(10).default(3),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  INDEXER_PAYMENTS_SOURCE: z.enum(['horizon', 'agentkarma']).default('horizon'),
  INDEXER_AGENTKARMA_URL: z.string().refine(isOrigin, 'must be an https origin (http only for localhost) with no path').default('https://agentkarma.io'),
});

/** Reads only the variables above. Errors name variables, never values. */
export function loadConfig(env: Record<string, string | undefined>): IndexerConfig {
  const parsed = schema.safeParse({
    INDEXER_DATABASE_URL: env.INDEXER_DATABASE_URL || undefined,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || undefined,
    INDEXER_SPONSORS: env.INDEXER_SPONSORS,
    INDEXER_HORIZON_RPS: env.INDEXER_HORIZON_RPS || undefined,
    PORT: env.PORT || undefined,
    INDEXER_PAYMENTS_SOURCE: env.INDEXER_PAYMENTS_SOURCE || undefined,
    INDEXER_AGENTKARMA_URL: env.INDEXER_AGENTKARMA_URL || undefined,
  });
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`invalid config: ${names.join(', ')}`);
  }
  const v = parsed.data;
  const sponsors = (v.INDEXER_SPONSORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (sponsors.some((s) => !G_ADDRESS.test(s))) throw new Error('invalid config: INDEXER_SPONSORS (each entry must be a G address)');
  return {
    port: v.PORT,
    databaseUrl: v.INDEXER_DATABASE_URL,
    ...CHAIN,
    publicBaseUrl: v.PUBLIC_BASE_URL,
    sponsors,
    horizonRps: v.INDEXER_HORIZON_RPS,
    paymentsSource: v.INDEXER_PAYMENTS_SOURCE,
    agentkarmaUrl: v.INDEXER_AGENTKARMA_URL,
  };
}
