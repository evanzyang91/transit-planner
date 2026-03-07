from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from .route import Route
    from .stop import Stop


class Agency(Base):
    __tablename__ = "agencies"

    agency_id: Mapped[str] = mapped_column(Text, primary_key=True)
    agency_name: Mapped[str] = mapped_column(Text, nullable=False)

    routes: Mapped[list["Route"]] = relationship(
        "Route",
        back_populates="agency",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    stops: Mapped[list["Stop"]] = relationship(
        "Stop",
        back_populates="agency",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )