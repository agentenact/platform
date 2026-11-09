/**
 * The desktop apps /connect walks through with an animated sketch: what to click, what to paste. Kept apart from
 * connect-config.ts (terminal lines) because each app here is a short click path, not one paste.
 *
 * Every path below follows the app maker's own docs as of 2026-11-04:
 * - Grok Bot: docs.x.ai/grok-bot/computer-and-apps (a Bot adds an MCP server "by URL"; secrets go in its masked secret card).
 * - Claude: claude.com/docs/connectors/custom (Customize › Connectors › Add custom connector; "No sign-in" + Request
 *   headers, a beta not every account has yet; Settings › Developer › Edit Config is the fallback).
 * - ChatGPT and Codex apps: learn.chatgpt.com/docs/extend/mcp (they share ~/.codex/config.toml; Settings › MCP servers;
 *   headers live only in the file, so the file is the one path that works).
 * The sketches are drawn in our own Night style, never a copy of the app's look.
 */
import { OWNER_MCP_URL } from './connect-config';

export type DesktopAppId = 'grok-bot' | 'claude' | 'codex';
export const SERVER_NAME = 'agentenact-mine';

/** What the sketch shows for a step. Each kind is drawn by components/desktop-setup.tsx. */
export type Scene =
  | { kind: 'chat'; who: 'you'; text: string }
  | { kind: 'secret' }
  | { kind: 'ask' }
  | { kind: 'menu'; path: readonly string[]; button: string }
  | { kind: 'form'; fields: readonly { label: string; value: string }[]; button: string }
  | { kind: 'file'; path: string; lines: readonly string[] }
  | { kind: 'servers'; button: string };

export interface DesktopStep {
  title: string;
  scene: Scene;
  /** Text to copy for this step: built from the owner's key when it shows the key. */
  paste?: (key: string) => string;
  pasteLabel?: string;
}

export interface DesktopApp {
  id: DesktopAppId;
  label: string;
  /** The window title in the sketch. */
  window: string;
  steps: readonly DesktopStep[];
  /** One plain line under the steps, or none. */
  note?: string;
  /** A second way, for accounts where the first is missing: label + lines to paste. */
  fallback?: { title: string; where: string; lines: (key: string) => string };
}

const masked = (key: string) => (key.startsWith('ae_pat_') ? `${key.slice(0, 11)}••••••••` : key);
export const maskKey = masked;

export const GROK_BOT_ASK = `Add an MCP server that isn't in the catalog: ${OWNER_MCP_URL}, named ${SERVER_NAME}. It needs the header Authorization with the value "Bearer " followed by my key. Ask me for the key in a secret card.`;

const ask: DesktopStep = { title: 'Ask in plain words', scene: { kind: 'ask' } };

export const DESKTOP_APPS: readonly DesktopApp[] = [
  {
    id: 'grok-bot',
    label: 'Grok Bot',
    window: 'Grok Bot',
    steps: [
      { title: 'Ask your Bot to add it', scene: { kind: 'chat', who: 'you', text: GROK_BOT_ASK }, paste: () => GROK_BOT_ASK, pasteLabel: 'Message' },
      { title: 'Paste your key in the secret card', scene: { kind: 'secret' }, paste: (key) => key, pasteLabel: 'Key' },
      ask,
    ],
    note: 'The key stays in the secret card: the Bot never sees it in the chat.',
  },
  {
    id: 'claude',
    label: 'Claude',
    window: 'Claude',
    steps: [
      { title: 'Open Customize, then Connectors', scene: { kind: 'menu', path: ['Customize', 'Connectors'], button: 'Add custom connector' } },
      {
        title: 'Paste the address, choose No sign-in',
        scene: {
          kind: 'form',
          fields: [
            { label: 'Name', value: 'AgentEnact' },
            { label: 'MCP server URL', value: OWNER_MCP_URL },
            { label: 'Authentication', value: 'No sign-in' },
          ],
          button: 'Next',
        },
        paste: () => OWNER_MCP_URL,
        pasteLabel: 'Address',
      },
      {
        title: 'Add your key under Request headers',
        scene: {
          kind: 'form',
          fields: [
            { label: 'Header', value: 'authorization' },
            { label: 'Value', value: 'Bearer {key}' },
            { label: 'Required', value: 'On' },
          ],
          button: 'Add',
        },
        paste: (key) => `Bearer ${key}`,
        pasteLabel: 'Value',
      },
      ask,
    ],
    note: 'Claude is still rolling Request headers out. If you do not see them, use the lines below instead.',
    fallback: {
      title: 'Settings › Developer › Edit Config',
      where: 'claude_desktop_config.json · needs Node.js',
      lines: (key) =>
        JSON.stringify(
          { mcpServers: { [SERVER_NAME]: { command: 'npx', args: ['-y', 'mcp-remote', OWNER_MCP_URL, '--header', 'Authorization:${AUTH}'], env: { AUTH: `Bearer ${key}` } } } },
          null,
          2,
        ),
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    window: 'Codex',
    steps: [
      {
        title: 'Paste these lines into ~/.codex/config.toml',
        scene: { kind: 'file', path: '~/.codex/config.toml', lines: [`[mcp_servers.${SERVER_NAME}]`, `url = "${OWNER_MCP_URL}"`, 'http_headers = { "Authorization" = "Bearer {key}" }'] },
        paste: (key) => `[mcp_servers.${SERVER_NAME}]\nurl = "${OWNER_MCP_URL}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }`,
        pasteLabel: 'config.toml',
      },
      { title: 'Open Settings, then MCP servers, and restart', scene: { kind: 'servers', button: 'Restart' } },
      ask,
    ],
    note: 'The Codex app, the codex command and the ChatGPT desktop app read the same file, so one paste covers all three.',
  },
];
