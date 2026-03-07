from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from .agency import Agency
    from .demand_summary import StopDemandSummary
    from .service_pattern import ServicePattern
    from .service_summary import (
        EdgeBurdenSummary,
        EdgeLoadSummary,
        EdgeServiceSummary,
    )


class Route(Base):
    __tablename__ = "routes"
    __table_args__ = (
        UniqueConstraint("agency_id", "route_id", name="uq_routes_agency_id_route_id"),
    )

    route_pk: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=True
    )
    agency_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("agencies.agency_id", ondelete="RESTRICT"),
        nullable=False,
    )
    route_id: Mapped[str] = mapped_column(Text, nullable=False)
    route_short_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    route_long_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    route_type: Mapped[int | None] = mapped_column(Integer, nullable=True)

    agency: Mapped[Agency] = relationship("Agency", back_populates="routes")
    service_patterns: Mapped[list[ServicePattern]] = relationship(
        "ServicePattern",
        back_populates="route",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    edge_service_summaries: Mapped[list[EdgeServiceSummary]] = relationship(
        "EdgeServiceSummary",
        back_populates="route",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edge_load_summaries: Mapped[list[EdgeLoadSummary]] = relationship(
        "EdgeLoadSummary",
        back_populates="route",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edge_burden_summaries: Mapped[list[EdgeBurdenSummary]] = relationship(
        "EdgeBurdenSummary",
        back_populates="route",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    stop_demand_summaries: Mapped[list[StopDemandSummary]] = relationship(
        "StopDemandSummary",
        back_populates="route",
        passive_deletes=True,
    )