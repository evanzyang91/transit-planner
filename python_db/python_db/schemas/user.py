from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import Field

from . import SchemaBase


class UserBase(SchemaBase):
    email: str
    full_name: str | None = None
    is_active: bool = True


class UserCreate(UserBase):
    password: str = Field(min_length=8)


class UserRead(UserBase):
    id: UUID
    created_at: datetime
    updated_at: datetime