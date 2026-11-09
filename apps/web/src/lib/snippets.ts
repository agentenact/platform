/**
 * Every code sample /create shows, in one place. These are text shown to developers for their own apps, never executed
 * here: the `process.env` reads below belong to the reader's server. tests/scaffold.test.ts skips exactly this file in its
 * env-read scan for that reason; nothing in this module reads the environment.
 */
import type { DraftData } from './draft-types';
import type { LibraryTemplate } from './library-templates';
import { OWNER_MCP_URL } from './mcp';

export const INSTALL = `bun add agentenact
bun add @stellar/stellar-sdk@16                 # create, adapters/stellar
bun add @x402/core @x402/stellar @x402/fetch    # serve, hire`;

export const IDENTITY = `import { createStellarAgent } from 'agentenact/create';

const born = await createStellarAgent({
  network: 'stellar:testnet',
  sponsorSecret: process.env.SPONSOR_SECRET!, // your own funded account; never stored
  agentUri: agent.agentUri,                   // from fromTemplate, or your own registration URL
});
// born.publicKey, born.secret (returned once: store it), born.agentId`;

export const SERVE = `import { createEnactServer } from 'agentenact/serve';
import { createStellarAdapter, stellarSecretToBytes } from 'agentenact/adapters/stellar';

const handler = await createEnactServer({
  network: 'stellar:testnet',
  agent: { address: born.publicKey, agentId: born.agentId, secret: stellarSecretToBytes(process.env.AGENT_SECRET!) },
  adapter: createStellarAdapter({ network: 'testnet' }),
  facilitator: { url: 'https://channels.openzeppelin.com/x402/testnet', apiKey: process.env.OZ_API_KEY! },
  resource: 'https://agent.example/translate',
  ...agent.serve, // price, description, handler from the template
});

Bun.serve({ port: 3000, fetch: handler });`;

export const VERIFY = `import { decodeRecordHeader, verifyRecord } from 'agentenact';
import { createStellarAdapter } from 'agentenact/adapters/stellar';

const result = await verifyRecord(
  decodeRecordHeader(response.headers.get('Enactment-Record')!),
  createStellarAdapter({ network: 'testnet' }),
);
// { ok, checks: { signature, settlement, timing, identity } }`;

/** Share a template: sign it, anchor its hash on your own account, push it to the open index. */
export const COMMUNITY_PUBLISH = `import { Horizon, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { signCommunityTemplate } from 'agentenact/community';
import { createStellarAdapter, stellarSecretToBytes, templateAnchorOperation } from 'agentenact/adapters/stellar';

const key = Keypair.fromSecret(process.env.AUTHOR_SECRET!);
const { template, sha256 } = await signCommunityTemplate({
  format: 'agentenact.template/1',
  slug: 'xlm-dip',
  version: 1,
  title: 'XLM dip alert',
  summary: 'Emails you when XLM dips in an hour, a chance to buy.',
  author: { network: 'stellar:testnet', address: key.publicKey(), name: 'your-handle' },
  createdAt: new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z'),
  kind: 'agentenact.draft/1',
  body: draft, // the draft shown under "As code"
}, stellarSecretToBytes(key.secret()), createStellarAdapter({ network: 'testnet' }));

// Anchor: manage_data "ae.tpl:xlm-dip" = the hash, on your own account (0.5 XLM reserve).
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const tx = new TransactionBuilder(await horizon.loadAccount(key.publicKey()), { fee: '100', networkPassphrase: Networks.TESTNET })
  .addOperation(templateAnchorOperation('xlm-dip', sha256))
  .setTimeout(60)
  .build();
tx.sign(key);
await horizon.submitTransaction(tx);

await fetch('https://api.agentenact.io/public/templates', { method: 'POST', body: JSON.stringify(template) });`;

/** Change or drop the handle without publishing a template. */
export const COMMUNITY_HANDLE = `import { signHandleChange } from 'agentenact/community';

const change = await signHandleChange({
  format: 'agentenact.handle/1',
  network: 'stellar:testnet',
  address: key.publicKey(),
  name: 'new-handle', // or null to drop it
  issuedAt: new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z'),
}, stellarSecretToBytes(key.secret()), createStellarAdapter({ network: 'testnet' }));

await fetch('https://api.agentenact.io/public/authors', { method: 'POST', body: JSON.stringify(change) });`;

/** The MCP server's setup for each harness (agentenact-mcp over stdio, read-only until a policy signer is set). */
export const MCP_CLAUDE = `claude mcp add agentenact \\
  -e AGENTENACT_NETWORK=stellar:testnet \\
  -- npx -y -p agentenact -p @stellar/stellar-sdk@16 agentenact-mcp`;

export const MCP_CODEX = `[mcp_servers.agentenact]
command = "npx"
args = ["-y", "-p", "agentenact", "-p", "@stellar/stellar-sdk@16", "agentenact-mcp"]
env = { AGENTENACT_NETWORK = "stellar:testnet" }`;

export const MCP_HERMES = `mcp_servers:
  agentenact:
    command: "npx"
    args: ["-y", "-p", "agentenact", "-p", "@stellar/stellar-sdk@16", "agentenact-mcp"]
    env:
      AGENTENACT_NETWORK: "stellar:testnet"`;

export const MCP_JSON = `{
  "mcpServers": {
    "agentenact": {
      "command": "npx",
      "args": ["-y", "-p", "agentenact", "-p", "@stellar/stellar-sdk@16", "agentenact-mcp"],
      "env": { "AGENTENACT_NETWORK": "stellar:testnet" }
    }
  }
}`;

export const MCP_HIRE = `AGENTENACT_SIGNER_URL=http://127.0.0.1:8402/sign   # your policy signer (agentenact/signer)
AGENTENACT_SIGNER_TOKEN=…                          # its bearer token, not a wallet key
AGENTENACT_BUDGET_USDC=0.10                        # the whole session
AGENTENACT_MAX_PER_CALL_USDC=0.05
AGENTENACT_MAX_DEPTH=2                             # A hires B hires C, no deeper`;

/** The owner MCP server (remote, over HTTP): talk to your own hosted agents with a key from /connect. */
export const OWN_CLAUDE = `claude mcp add --transport http agentenact-mine ${OWNER_MCP_URL} \\
  --header "Authorization: Bearer <your key>"`;

export const OWN_CODEX = `[mcp_servers.agentenact-mine]
url = "${OWNER_MCP_URL}"
http_headers = { "Authorization" = "Bearer <your key>" }`;

export const OWN_HERMES = `mcp_servers:
  agentenact-mine:
    url: "${OWNER_MCP_URL}"
    headers:
      Authorization: "Bearer <your key>"`;

/** Grok Build, xAI's terminal agent (docs.x.ai/build/features/mcp-servers): one command writes ~/.grok/config.toml. */
export const OWN_GROK = `grok mcp add --transport http agentenact-mine ${OWNER_MCP_URL} \\
  --header "Authorization: Bearer <your key>"`;

/** What agentenact-mcp gives a harness. */
export const MCP_TOOLS = [
  ['find_agents', 'Search the on-chain registry by what agents say they do. No indexer, no third-party API.'],
  ['get_agent', 'Owner and wallet from chain, plus the services the agent publishes: url, price, input.'],
  ['verify_record', 'The four checks on any record, and whether a given output is exactly what it sealed.'],
  ['start_task', 'Open a task with a USDC budget. Every hire is paid from one.'],
  ['hire_agent', 'Pay a service over x402 and get its output with its record, verified.'],
  ['get_task', 'Who was paid, the transactions, and the child records, ready to cite in your own output.'],
] as const;

/** What the owner MCP server gives a harness. */
export const OWN_TOOLS = [
  ['list_my_agents', 'Your agents, their state and their public pages.'],
  ['get_my_agent', 'What one agent is doing, its limits for today, and what it sells.'],
  ['message_agent', 'Talk to it, the same chat as in the panel, within its daily limits.'],
  ['list_runs · get_run', 'What it ran, what it found, and the record of every paid run.'],
  ['get_activity', 'Its last days, in the same words as its page.'],
  ['pause_agent · resume_agent', 'Stop it or start it again.'],
  ['find_agents · get_agent', 'Any agent on chain: what it sells, its price, its owner and its proven sales.'],
  ['verify_record', 'The four checks on any record, and whether an output is exactly what it sealed.'],
  ['hire_agent', 'Your agent hires another one, paid from its own wallet within its caps; the record is checked.'],
] as const;

/** A library template's snippet: start it with these params (its example ones by default) and your own model. */
export function templateSnippet(t: LibraryTemplate, params: Record<string, string> = { ...t.example }): string {
  const list = Object.entries(params)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');
  return [
    `import { fromTemplate, getTemplate } from 'agentenact/templates';`,
    ``,
    `const agent = fromTemplate(getTemplate('${t.id}')!, {`,
    `  params: { ${list} },`,
    `  model: async ({ instructions, input }) => myModel(instructions, input),`,
    `});`,
    `// agent.agentUri → createStellarAgent · agent.serve → createEnactServer`,
  ].join('\n');
}

/**
 * A ready agent as the hosted runtime runs it: its description with the builder's values bound in. Empty lists are left out
 * so the sample shows what the agent does; the draft flow sends the full description.
 */
export function hostedSnippet(d: DraftData): string {
  const shown = Object.fromEntries(Object.entries(d.spec).filter(([, v]) => !(Array.isArray(v) && v.length === 0)));
  return JSON.stringify({ name: d.name, ...shown }, null, 2);
}
