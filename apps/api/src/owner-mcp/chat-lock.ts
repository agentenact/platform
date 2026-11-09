/**
 * One owner conversation per agent at a time, shared by the panel chat (gateway/runtime.ts) and the owner MCP
 * `message_agent` tool: two at once would race the agent's run budget and memory writes. The claim is a lease
 * (db/leases.ts), so it holds across replicas and a replica that dies mid-conversation frees it at once.
 */
import { createMemoryLeases, type Leases } from '../db/leases.js';

/** Longer than any turn (a chat stream is cut at 120 s idle); only bounds a holder that never releases. */
export const CHAT_LEASE_MS = 10 * 60_000;

export interface ChatLock {
  /** Takes the agent's lock and returns its release, or null when a conversation is already running. */
  take(agentId: string): Promise<(() => void) | null>;
}

export function createChatLock(leases: Leases = createMemoryLeases()): ChatLock {
  return {
    async take(agentId) {
      const release = await leases.take(`chat:${agentId}`, CHAT_LEASE_MS);
      if (!release) return null;
      return () => void release().catch(() => undefined); // a failed delete still expires with the lease
    },
  };
}
