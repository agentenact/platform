/**
 * The setup lines for each AI tool that can reach the owner MCP server (api POST /mcp). Kept out of copy.ts: these are
 * config the owner pastes, so they name an Authorization header, and the panel shows them inside [data-advanced] only.
 */
import { PUBLIC } from './public-config';

export const OWNER_MCP_URL = `${PUBLIC.apiUrl}/mcp`;
/** Stands in for the key until one is made on this page. */
export const KEY_PLACEHOLDER = '<your key>';

export interface HarnessSetup {
  id: 'claude-code' | 'codex' | 'hermes' | 'grok-build';
  label: string;
  /** Where the lines go. */
  where: string;
  lines: (key: string) => string;
}

export const HARNESS_SETUPS: readonly HarnessSetup[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    where: 'Run once in a terminal',
    lines: (key) => `claude mcp add --transport http agentenact-mine ${OWNER_MCP_URL} \\\n  --header "Authorization: Bearer ${key}"`,
  },
  {
    id: 'codex',
    label: 'Codex',
    where: '~/.codex/config.toml',
    lines: (key) => `[mcp_servers.agentenact-mine]\nurl = "${OWNER_MCP_URL}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }`,
  },
  {
    id: 'hermes',
    label: 'Hermes',
    where: '~/.hermes/config.yaml',
    lines: (key) => `mcp_servers:\n  agentenact-mine:\n    url: "${OWNER_MCP_URL}"\n    headers:\n      Authorization: "Bearer ${key}"`,
  },
  {
    id: 'grok-build',
    label: 'Grok Build',
    where: 'Run once in a terminal',
    lines: (key) => `grok mcp add --transport http agentenact-mine ${OWNER_MCP_URL} \\\n  --header "Authorization: Bearer ${key}"`,
  },
];
