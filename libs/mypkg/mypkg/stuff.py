"""Shared utilities and constants."""
from __future__ import annotations

import os

thing = "shared"


def get_env_bool(name: str, default: bool = False) -> bool:
    """Return True if env var is set to a truthy value, else default."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")
