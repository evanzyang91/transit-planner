"""Pydantic schemas package for python_db.

Export shared base schemas and common types here to simplify imports.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from .user import UserCreate, UserRead

__all__ = ["SchemaBase", "UserCreate", "UserRead"]


class SchemaBase(BaseModel):
    """Base schema with consistent configuration defaults."""

    model_config = ConfigDict(from_attributes=True)


