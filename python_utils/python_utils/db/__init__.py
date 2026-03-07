"""Lightweight DB package initializer.

Avoid importing runtime-configured modules (like session/engine creation)
at package import time to keep this package safe in tooling and tests.
"""

from .base import Base

__all__ = ["Base"]