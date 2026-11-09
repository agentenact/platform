/**
 * The reads behind the agent page's other tabs (What it does, Skills, Earnings). Each tab's panel streams in with the page
 * and reads its own route; the page above it has already checked the agent is the owner's. Any failure is null: that one
 * panel says it could not load, the page and the other tabs carry on.
 */
import { asSales, type SaleItem } from '@/lib/agent-types';
import type { SpecShown } from '@/lib/edit';
import { asHeld, type SkillsHeld } from '@/lib/skills';
import { asSpecShown } from '@/lib/spec-types';
import type { ApiCall } from './api';
import { cachedApi } from './me';
import { accessToken } from './session';

/** `name` is the agent's, for a description that has no view of its own. */
export type LoadPanel<T> = (agentId: string, name: string) => Promise<T | null>;

export function createLoadPanel<T>(
  d: { token(): Promise<string | undefined>; api: ApiCall },
  path: (id: string) => string,
  parse: (json: unknown, name: string) => T | null,
): LoadPanel<T> {
  return async (agentId, name) => {
    try {
      const token = await d.token();
      if (!token) return null;
      const res = await d.api(path(agentId), { token });
      return res.status === 200 ? parse(res.json, name) : null;
    } catch {
      return null;
    }
  };
}

const deps = { token: accessToken, api: cachedApi };
export const loadEditPanel: LoadPanel<SpecShown> = createLoadPanel(deps, (id) => `/api/agents/${id}/spec`, (json, name) => asSpecShown(json, name));
export const loadSkillsPanel: LoadPanel<SkillsHeld> = createLoadPanel(deps, (id) => `/api/agents/${id}/skills`, (json) => asHeld(json));
export const loadEarningsPanel: LoadPanel<SaleItem[]> = createLoadPanel(deps, (id) => `/api/agents/${id}/earnings`, (json) => asSales(json));
