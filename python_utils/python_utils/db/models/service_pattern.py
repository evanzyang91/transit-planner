from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from .network_edge import PatternEdge
    from .route import Route
    from .stop import Stop


class ServicePattern(Base):
    __tablename__ = "service_patterns"
    __table_args__ = (
        UniqueConstraint("route_pk", "pattern_hash", name="uq_service_patterns_route_hash"),
    )

    pattern_pk: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        autoincrement=True,
    )
    route_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("routes.route_pk", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    direction_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pattern_hash: Mapped[str] = mapped_column(Text, nullable=False)

    route: Mapped["Route"] = relationship(
        "Route",
        back_populates="service_patterns",
    )

    pattern_stops: Mapped[list["PatternStop"]] = relationship(
        "PatternStop",
        back_populates="service_pattern",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PatternStop.stop_sequence",
    )

    pattern_edges: Mapped[list["PatternEdge"]] = relationship(
        "PatternEdge",
        back_populates="service_pattern",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PatternEdge.edge_order",
    )


class PatternStop(Base):
    __tablename__ = "pattern_stops"

    pattern_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("service_patterns.pattern_pk", ondelete="CASCADE"),
        primary_key=True,
    )
    stop_sequence: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
    )
    stop_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("stops.stop_pk", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )

    service_pattern: Mapped["ServicePattern"] = relationship(
        "ServicePattern",
        back_populates="pattern_stops",
    )
    stop: Mapped["Stop"] = relationship(
        "Stop",
        back_populates="pattern_stops",
    )