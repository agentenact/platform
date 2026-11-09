import type { Db } from './db.js';

export type HealthDeps = { sql: Db; now?: () => Date };

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * `GET /health` only: 200 `{ ok, heartbeatAgeS }` when the database answers, 503 otherwise. `halted` appears once a
 * chain reset has stopped the events and payments stages, so a healthy-looking process is never read as a working one.
 * Content-free: no agent, wallet or payment data.
 */
export function createHealth(d: HealthDeps): (req: Request) => Promise<Response> {
  const now = d.now ?? (() => new Date());
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.pathname !== '/health') return json(404, { ok: false });
    try {
      const rows = (await d.sql`select key, value from discovery.meta where key in ('heartbeat_at', 'halted')`) as Array<{ key: string; value: string }>;
      const beat = rows.find((r) => r.key === 'heartbeat_at');
      const at = beat ? Date.parse(beat.value) : NaN;
      const heartbeatAgeS = Number.isNaN(at) ? null : Math.max(0, Math.floor((now().getTime() - at) / 1000));
      const halted = rows.find((r) => r.key === 'halted');
      return json(200, halted ? { ok: true, heartbeatAgeS, halted: halted.value } : { ok: true, heartbeatAgeS });
    } catch {
      return json(503, { ok: false });
    }
  };
}

/** Starts the health listener. Lives here because Bun.serve takes a `fetch` handler, which is inbound, not egress. */
export function serveHealth(d: HealthDeps & { port: number }): { stop(): Promise<void> } {
  const server = Bun.serve({ port: d.port, fetch: createHealth(d) });
  return { stop: async () => void (await server.stop()) };
}
