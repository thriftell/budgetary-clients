export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/**
 * A server-returned `[0, 1]` share as a percentage. This changes the UNIT of a
 * measured number and nothing else — it is not a bucket, a threshold or a
 * judgment, and there is no client-side classification anywhere near it.
 *
 * A share that is positive but would round to `0%` renders `<1%` instead:
 * printing "0%" for tokens that were actually measured is exactly the kind of
 * small lie this dashboard doesn't tell (the same reason a void row says "no
 * prediction" rather than "pending"). Anything non-finite or absent is an
 * em-dash — never a substituted value.
 */
export function formatShare(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return "—";
  const pct = share * 100;
  const rounded = Math.round(pct);
  if (rounded === 0 && pct > 0) return "<1%";
  return `${rounded}%`;
}

export function truncateEstimateId(id: string, max = 12): string {
  if (id.length <= max) return id;
  return `${id.slice(0, max)}…`;
}

export function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
