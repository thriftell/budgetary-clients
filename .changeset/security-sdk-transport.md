---
"@budgetary/sdk": minor
---

Harden the SDK HTTP transport so the bearer token can't leak and a hostile endpoint can't exhaust or hang the client.

- **Enforce HTTPS on `baseUrl`.** The client attaches `Authorization: Bearer <key>` to whatever base URL it is given, so it now refuses a non-`https:` `baseUrl` at construction unless the host is a loopback address (`localhost`/`127.0.0.1`/`::1`) or the new `allowInsecure` option is set. The same check is applied when adopting a `base_url` from `~/.budgetary/config.json`: an insecure host is dropped for the secure default rather than sending the key in cleartext.
- **No redirects.** The `fetch` call now passes `redirect: "error"`, so a hostile endpoint's `3xx` can no longer re-POST the request body (and the `Authorization` header) to a `Location` host (parity with the Python SDK's httpx `follow_redirects=False` default).
- **Cap the response body.** The body is read with an 8 MiB ceiling — an oversized `Content-Length` is rejected up-front and a lying/absent one is aborted mid-stream — so a giant body can't exhaust memory.

**Behavior delta:** a `baseUrl` that is `http://` to a non-loopback host is now refused at construction (previously accepted); pass `allowInsecure: true` to opt back in for a trusted local endpoint. `https://` and localhost URLs are unchanged.
