"""ORM models package for python_db.

Import model classes here so Alembic can discover them via python_db.models.
"""

from __future__ import annotations

from .user import User

__all__ = ["User"]