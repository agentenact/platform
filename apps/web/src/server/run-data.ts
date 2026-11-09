/**
 * One run for the activity row, read with the signed-in owner's token. The api answers 404 for an unknown or foreign run;
 * here every failure is just "no run" (status-based, no body is looked at beyond a 200 answer's JSON).
 */
import { asRunDetail } from '@/lib/agent-types';
import type { RunOut } from '@/lib/run-details';
import { apiCall, type ApiCall } from './api';
import { accessToken } from './session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LoadRun = (agentId: string, runId: string) => Promise<RunOut>;

export function createLoadRun(d: { api: ApiCall; token(): Promise<string | undefined> }): LoadRun {
  return async (agentId, runId) => {
    if (!UUID.test(agentId) || !UUID.test(runId)) return { ok: false };
    try {
      const token = await d.token();
      if (!token) return { ok: false };
      const res = await d.api(`/api/agents/${agentId}/runs/${runId}`, { token });
      const run = res.status === 200 ? asRunDetail(res.json) : null;
      return run ? { ok: true, run } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export const loadRun: LoadRun = createLoadRun({ api: apiCall, token: accessToken });
