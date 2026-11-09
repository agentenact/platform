/**
 * The logic behind the creation server actions (app/actions/create.ts), with its dependencies injected for tests.
 * Each action maps one fixed api route to plain data. Failures carry the status and the api's error code, never a message
 * and never an error object; the browser decides what to say. Traefik replaces 404/5xx bodies, so callers branch on status.
 */
import type { SerializedCredential } from '@/mirror/owner-client/credential';
import type { PublicSignRequest } from '@/mirror/owner-client/types';
import type { ApiCall } from './api';

export type Out<T> = ({ ok: true } & T) | { ok: false; status: number; code?: string };

export interface AgentInfo {
  status: string;
  step: string | null;
  error: string | null;
  needsOperator: boolean;
  lastStart: { outcome: string; code?: string } | null;
}
export interface WalletInfo {
  contractId: string;
  credentialId: string;
  credential: SerializedCredential;
}

export interface CreateDeps {
  api: ApiCall;
  token(): Promise<string | undefined>;
  /** One line per failed call: the route (ids masked), status, the api's code, or a thrown error's class name. Never a body. */
  log?: (e: Record<string, unknown>) => void;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function createCreateActions(d: CreateDeps) {
  const log = d.log ?? ((e) => console.info(JSON.stringify(e)));
  const failed = (path: string, method: string, status: number, extra: Record<string, unknown> = {}) =>
    log({ event: 'create_call_failed', route: `${method} ${path.replace(UUID_IN_PATH, ':id')}`, status, ...extra });
  async function call<T>(path: string, o: { method?: 'GET' | 'POST'; body?: unknown; forwardIp?: boolean }, pick: (json: Record<string, unknown>) => T | null): Promise<Out<T extends object ? T : never>> {
    const method = o.method ?? (o.body !== undefined ? 'POST' : 'GET');
    try {
      const token = await d.token();
      if (!token) {
        failed(path, method, 401, { code: 'no_session' });
        return { ok: false, status: 401, code: 'unauthorized' };
      }
      const res = await d.api(path, { token, ...(o.method ? { method: o.method } : {}), ...(o.body !== undefined ? { body: o.body } : {}), ...(o.forwardIp ? { forwardIp: true } : {}) });
      const json = obj(res.json);
      if (res.status === 200 || res.status === 202 || res.status === 204) {
        const picked = pick(json);
        if (picked) return { ok: true, ...picked } as Out<T extends object ? T : never>;
        failed(path, method, 502, { got: res.status });
        return { ok: false, status: 502 };
      }
      const code = str(json.error);
      // 409s the flow expects (agent_limit, wallet_exists, wallet_pending) are answers, not failures.
      if (res.status !== 409) failed(path, method, res.status, code ? { code } : {});
      return { ok: false, status: res.status, ...(code ? { code } : {}) };
    } catch (e) {
      // Nothing here carries the error object: its class name only.
      failed(path, method, 503, { threw: e instanceof Error ? e.name : typeof e });
      return { ok: false, status: 503 };
    }
  }
  const idOk = (id: string) => UUID.test(id);
  const badId = (): Out<never> => ({ ok: false, status: 400, code: 'bad_request' });

  return {
    me: () =>
      call('/api/me', {}, (j) => {
        const agent = obj(j.agent);
        return { ownerAddress: str(j.ownerAddress), agentId: str(agent.id) };
      }),
    passkeyOptions: () => call('/api/passkey/options', { method: 'POST', body: {}, forwardIp: true }, (j) => (j.optionsJSON ? { optionsJSON: j.optionsJSON } : null)),
    passkeyRegister: (response: unknown) =>
      call('/api/passkey/register', { body: { response }, forwardIp: true }, (j) => (str(j.ownerAddress) ? { ownerAddress: str(j.ownerAddress)! } : null)),
    wallet: () =>
      call<WalletInfo>('/api/wallet', {}, (j) => {
        const contractId = str(j.contractId);
        const credentialId = str(j.credentialId);
        const credential = obj(j.credential);
        return contractId && credentialId && typeof credential.publicKey === 'string' ? { contractId, credentialId, credential: credential as unknown as SerializedCredential } : null;
      }),
    createAgent: (input: { name: string; spec: unknown; view: unknown; key?: string; skillSet?: { id: string; revision: number } }) =>
      call('/api/agents', { body: input }, (j) => (str(j.id) ? { id: str(j.id)!, resumed: j.resumed === true } : null)),
    agent: (id: string): Promise<Out<AgentInfo>> => {
      if (!idOk(id)) return Promise.resolve(badId());
      return call<AgentInfo>(`/api/agents/${id}`, {}, (j) => {
        const prov = obj(j.provision);
        const last = obj(j.lastStart);
        const status = str(j.status);
        if (!status) return null;
        const code = str(last.code);
        return {
          status,
          step: str(prov.step),
          error: str(prov.error),
          needsOperator: j.needsOperator === true,
          lastStart: str(last.outcome) ? { outcome: str(last.outcome)!, ...(code ? { code } : {}) } : null,
        };
      });
    },
    retry: (id: string): Promise<Out<{ id: string }>> => (idOk(id) ? call(`/api/agents/${id}/retry`, { method: 'POST', body: {} }, (j) => ({ id: str(j.id) ?? id })) : Promise.resolve(badId())),
    signRequests: (): Promise<Out<{ requests: PublicSignRequest[] }>> => listRequests(d),
    sign: (id: string, signedEntryXdr: string): Promise<Out<object>> => (idOk(id) ? call(`/api/sign-requests/${id}/sign`, { body: { signedEntryXdr } }, () => ({})) : Promise.resolve(badId())),
    reject: (id: string): Promise<Out<object>> => (idOk(id) ? call(`/api/sign-requests/${id}/reject`, { method: 'POST', body: {} }, () => ({})) : Promise.resolve(badId())),
  };
}

const KINDS = new Set(['register', 'bind']);
async function listRequests(d: CreateDeps): Promise<Out<{ requests: PublicSignRequest[] }>> {
  try {
    const token = await d.token();
    if (!token) return { ok: false, status: 401, code: 'unauthorized' };
    const res = await d.api('/api/sign-requests', { token });
    if (res.status !== 200) return { ok: false, status: res.status };
    if (!Array.isArray(res.json)) return { ok: false, status: 502 };
    // The gate re-checks everything; this only drops entries that are not shaped like a request at all.
    const requests = res.json.filter((r): r is PublicSignRequest => {
      const o = obj(r);
      return typeof o.id === 'string' && typeof o.kind === 'string' && KINDS.has(o.kind) && typeof o.entryXdr === 'string' && typeof o.agentId === 'string';
    });
    return { ok: true, requests };
  } catch {
    return { ok: false, status: 503 };
  }
}
