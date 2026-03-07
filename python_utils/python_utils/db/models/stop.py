from __future__ import annotations

from typing import TYPE_CHECKING

from geoalchemy2 import Geometry
from sqlalchemy import BigInteger, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.agency import Agency
    from python_utils.db.models.demand_summary import StopDemandSummary
    from python_utils.db.models.network_edge import NetworkEdge
    from python_utils.db.models.service_pattern import PatternStop


class Stop(Base):
    __tablename__ = "stops"
    __table_args__ = (
        UniqueConstraint("agency_id", "stop_id", name="uq_stops_agency_stop_id"),
    )

    stop_pk: Mapped[int] = mapped_column(
        BigInteger, primary_key=True, autoincrement=True
    )
    agency_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("agencies.agency_id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    stop_id: Mapped[str] = mapped_column(Text, nullable=False)
    stop_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    geom: Mapped[object] = mapped_column(
        Geometry("POINT", srid=4326, spatial_index=True),
        nullable=False,
    )

    agency: Mapped["Agency"] = relationship(
        "Agency",
        back_populates="stops",
    )

    # Ordered stops within service patterns
    pattern_stops: Mapped[list["PatternStop"]] = relationship(
        "PatternStop",
        back_populates="stop",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # Directed network edges touching this stop
    outgoing_edges: Mapped[list["NetworkEdge"]] = relationship(
        "NetworkEdge",
        foreign_keys="NetworkEdge.from_stop_pk",
        back_populates="from_stop",
    )
    incoming_edges: Mapped[list["NetworkEdge"]] = relationship(
        "NetworkEdge",
        foreign_keys="NetworkEdge.to_stop_pk",
        back_populates="to_stop",
    )

    demand_summaries: Mapped[list["StopDemandSummary"]] = relationship(
        "StopDemandSummary",
        back_populates="stop",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )