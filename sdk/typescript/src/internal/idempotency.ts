/**
 * Resolves a `clientRequestId` according to SDK semantics:
 *  - `undefined`  → auto-generate a fresh UUID v4 (safe-by-default retries).
 *  - `null`       → explicit opt-out; no id is sent on the wire.
 *  - a string     → caller-supplied; passed through unchanged.
 */
export function resolveClientRequestId(
  provided: string | null | undefined,
): string | undefined {
  if (provided === null) return undefined;
  if (provided !== undefined) return provided;
  return crypto.randomUUID();
}
