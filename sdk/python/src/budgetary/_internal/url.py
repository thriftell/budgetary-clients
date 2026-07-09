"""Base-URL scheme safety.

The client attaches ``Authorization: Bearer <key>`` to whatever ``base_url`` it is
given, so a non-HTTPS base URL would send the key in cleartext to whatever host it
names. This is the single gate that decides which base URLs may carry the key.
"""

from __future__ import annotations

from urllib.parse import urlsplit

_LOCAL_HOSTS = frozenset(
    {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}
)


def is_base_url_allowed(base_url: str, allow_insecure: bool = False) -> bool:
    """Whether ``base_url`` may carry the bearer token.

    Allowed when it is ``https``, or ``allow_insecure`` is set (an explicit opt-in
    for a trusted lab), or it is a plain-``http`` loopback address (local
    development, where nothing leaves the machine). Everything else — ``http`` to a
    real host, a non-HTTP(S) scheme, or an unparseable value — is refused.
    """
    try:
        parts = urlsplit(base_url)
    except ValueError:
        return False
    scheme = parts.scheme.lower()
    if scheme == "https":
        return True
    if scheme != "http":
        return False  # no file:, ftp:, ws:, …
    if allow_insecure:
        return True
    host = (parts.hostname or "").lower()
    return host in _LOCAL_HOSTS
