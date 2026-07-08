"""Three-way resolution for ``client_request_id``."""

from __future__ import annotations

import uuid
from typing import Any


class _UnsetType:
    """Singleton sentinel for ``client_request_id`` defaults."""

    _instance: "_UnsetType | None" = None

    def __new__(cls) -> "_UnsetType":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "<UNSET>"

    def __bool__(self) -> bool:  # pragma: no cover - cosmetic
        return False


_UNSET: Any = _UnsetType()


def resolve_client_request_id(provided: str | None | _UnsetType) -> str | None:
    """Three-way resolution.

    * ``_UNSET`` → auto-generate a fresh UUID v4 (safe-by-default retries).
    * ``None``   → explicit opt-out; the caller wants no ``client_request_id``.
    * ``str``    → passed through verbatim.
    """
    if isinstance(provided, _UnsetType):
        return str(uuid.uuid4())
    return provided
