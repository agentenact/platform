/** Plain-word time and money for the agent page. Relative, never a clock time: the server's zone is not the visitor's. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "0.0030000" -> "0.003". */
export function formatUsdc(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago". */
export function ago(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${plural(Math.floor(d / HOUR), 'hour', 'hours')} ago`;
  if (d < 2 * DAY) return 'yesterday';
  return `${Math.floor(d / DAY)} days ago`;
}

/** "3 min from now" for the next check, or null when it is due (the caller then says "any moment now"). */
export function untilNext(iso: string, now: number): string | null {
  const d = Date.parse(iso) - now;
  if (d < 45_000) return null;
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min from now`;
  if (d < DAY) return `${plural(Math.round(d / HOUR), 'hour', 'hours')} from now`;
  return `${plural(Math.round(d / DAY), 'day', 'days')} from now`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Time left as a clock, "4:07" or "1:02:30"; null at or past the moment. */
export function clockLeft(ms: number): string | null {
  if (!(ms > 0)) return null;
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A UTC day (YYYY-MM-DD) as "today", "yesterday" or "on Oct 11". */
export function dayWord(day: string, now: number): string {
  const today = new Date(now).toISOString().slice(0, 10);
  if (day === today) return 'today';
  if (day === new Date(now - DAY).toISOString().slice(0, 10)) return 'yesterday';
  const [, m, d] = day.split('-');
  return `on ${MONTHS[Number(m) - 1] ?? ''} ${Number(d)}`.replace('  ', ' ');
}

/** A proof link is used only when it is a secure web address (https). */
export function safeUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' ? p.href : null;
  } catch {
    return null;
  }
}
