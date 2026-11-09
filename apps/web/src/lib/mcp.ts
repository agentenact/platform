/**
 * True since agentenact 0.2.0, the first npm release with the `agentenact-mcp` bin (0.1.0 and 0.1.1 have none).
 * While false, every MCP mention says it ships with the next release.
 */
export const MCP_ON_NPM = true;

/** The harnesses the /create setup gives a config for. */
export const MCP_HARNESSES = ['Claude Code', 'Codex', 'Hermes', 'Grok Build'] as const;

/** True since api.agentenact.io serves the owner MCP server (POST /mcp) and /connect makes keys for it. */
export const OWNER_MCP_LIVE = true;

/** Where an owner makes a key for the owner MCP server: this app's own page. */
export const OWNER_MCP_CONNECT_URL = '/connect';
export const OWNER_MCP_URL = 'https://api.agentenact.io/mcp';
