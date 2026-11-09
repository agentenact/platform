/**
 * Whether the agent page shows the card pointing to skills. Never fatal: any failure is "no card". Only the list is read
 * here (one database read on the api); suggestions reach skills.sh and are asked for once by the Skills panel when the page
 * opens, never by the 30-second refresh.
 */
import { asHeld, showSkillsCard } from '@/lib/skills';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

export type LoadSkillsHint = (agentId: string) => Promise<boolean>;

export function createLoadSkillsHint(d: { token(): Promise<string | undefined>; api: ApiCall }): LoadSkillsHint {
  return async (agentId) => {
    try {
      const token = await d.token();
      if (!token) return false;
      const res = await d.api(`/api/agents/${agentId}/skills`, { token });
      return res.status === 200 && showSkillsCard(asHeld(res.json));
    } catch {
      return false;
    }
  };
}

export const loadSkillsHint: LoadSkillsHint = createLoadSkillsHint({ token: accessToken, api: apiCall });
