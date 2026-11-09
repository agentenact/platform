/** Public values only. Safe to ship to the browser; secrets live under src/server/ and are read from the environment. */
export const PUBLIC = {
  apiUrl: 'https://api.agentenact.io',
  // The canonical origin. A deployment's own origin (staging) comes from APP_ORIGIN, see src/server/origin.ts.
  appOrigin: 'https://agentenact.io',
  supabaseUrl: 'https://supabase.agentenact.io',
  // Kong's anon key: public by design, same value pinned in apps/api/servel.yaml.
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjIxMDY3NjYxNTEsImlhdCI6MTc5MTE0Njk1MSwiaXNzIjoic3VwYWJhc2UiLCJyb2xlIjoiYW5vbiJ9.cp1pDWGSbFUKnBCg7oRWYSr_VEVX0MJ1_3d1D1p1rbc',
  sorobanRpc: 'https://soroban-testnet.stellar.org',
  uriPrefix: 'https://agentenact.io/a/',
  rpId: 'agentenact.io',
} as const;
