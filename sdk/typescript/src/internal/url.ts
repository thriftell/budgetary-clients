// Base-URL scheme safety. The client attaches `Authorization: Bearer <key>` to
// whatever `baseUrl` it is given, so a non-HTTPS base URL would send the key in
// cleartext to whatever host it names. This module is the single gate that
// decides which base URLs are allowed to carry the key.

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * Whether `baseUrl` may carry the bearer token. Allowed when it is `https:`, or
 * `allowInsecure` is set (an explicit opt-in for a trusted lab), or it is a
 * plain-`http:` LOOPBACK address (local development, where nothing leaves the
 * machine). Everything else — `http://` to a real host, or a non-HTTP(S) scheme
 * such as `file:`/`ftp:`, or an unparseable value — is refused.
 */
export function isBaseUrlAllowed(baseUrl: string, allowInsecure = false): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false; // no file:, ftp:, ws:, …
  if (allowInsecure) return true;
  return LOCAL_HOSTS.has(url.hostname);
}

/**
 * Throw unless `baseUrl` may safely carry the bearer token (see
 * {@link isBaseUrlAllowed}). The message names the scheme/host (never a secret —
 * the base URL carries no key) and points at the escape hatches.
 */
export function assertAllowedBaseUrl(
  baseUrl: string,
  allowInsecure = false,
): void {
  if (isBaseUrlAllowed(baseUrl, allowInsecure)) return;
  throw new Error(
    `BudgetaryClient: refusing a non-HTTPS baseUrl (${baseUrl}) — the API key ` +
      "would be sent in cleartext. Use an https:// URL, a localhost address, or " +
      "set `allowInsecure: true` to override for a trusted local endpoint.",
  );
}
