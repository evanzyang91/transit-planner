"""Shared utilities for transit-planner Python packages."""
from __future__ import annotations

from .helpers import get_env_bool

# Intentionally do NOT import .db at package import time.
# This keeps python_utils lightweight and avoids eager DB initialization
# (e.g., DATABASE_URL validation) for callers that only need helpers.

__all__ = ["get_env_bool"]