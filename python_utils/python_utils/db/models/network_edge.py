from __future__ import annotations

from typing import TYPE_CHECKING

from geoalchemy2 import Geometry
from sqlalchemy import BigInteger, Float, ForeignKey, Integer, PrimaryKeyConstraint, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.service_pattern import ServicePattern
    from python_utils.db.models.stop import Stop
    from python_utils.db.models.service_summary import (
        EdgeBurdenSummary,
        EdgeLoadSummary,
        EdgeServiceSummary,
    )
    from python_utils.db.models.scenario import (
        ScenarioEdgeCapture,
        ScenarioProposedEdgeService,
    )


class NetworkEdge(Base):
    """
    Directed edge between two stops in the static transit network graph.
    """

    __tablename__ = "network_edges"
    __table_args__ = (
        UniqueConstraint(
            "from_stop_pk",
            "to_stop_pk",
            name="uq_network_edges_from_stop_pk_to_stop_pk",
        ),
    )

    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        autoincrement=True,
    )
    from_stop_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("stops.stop_pk", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    to_stop_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("stops.stop_pk", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    geom: Mapped[object] = mapped_column(
        Geometry("LINESTRING", srid=4326, spatial_index=True),
        nullable=False,
    )
    length_m: Mapped[float | None] = mapped_column(Float(precision=53), nullable=True)

    # Stop topology relationships
    from_stop: Mapped["Stop"] = relationship(
        "Stop",
        foreign_keys=[from_stop_pk],
        back_populates="outgoing_edges",
    )
    to_stop: Mapped["Stop"] = relationship(
        "Stop",
        foreign_keys=[to_stop_pk],
        back_populates="incoming_edges",
    )

    # Pattern composition
    pattern_edges: Mapped[list["PatternEdge"]] = relationship(
        "PatternEdge",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PatternEdge.edge_order",
    )

    # Operational summary fact tables (defined in service_summary.py)
    edge_service_summaries: Mapped[list["EdgeServiceSummary"]] = relationship(
        "EdgeServiceSummary",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edge_load_summaries: Mapped[list["EdgeLoadSummary"]] = relationship(
        "EdgeLoadSummary",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edge_burden_summaries: Mapped[list["EdgeBurdenSummary"]] = relationship(
        "EdgeBurdenSummary",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    # Scenario analysis overlays (defined in scenario.py)
    scenario_edge_captures: Mapped[list["ScenarioEdgeCapture"]] = relationship(
        "ScenarioEdgeCapture",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    scenario_proposed_edge_services: Mapped[list["ScenarioProposedEdgeService"]] = relationship(
        "ScenarioProposedEdgeService",
        back_populates="edge",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class PatternEdge(Base):
    """
    Ordered mapping from a service pattern to edges in the network graph.
    """

    __tablename__ = "pattern_edges"
    __table_args__ = (
        PrimaryKeyConstraint("pattern_pk", "edge_order", name="pk_pattern_edges"),
    )

    pattern_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("service_patterns.pattern_pk", ondelete="CASCADE"),
        nullable=False,
    )
    edge_order: Mapped[int] = mapped_column(Integer, nullable=False)
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    service_pattern: Mapped["ServicePattern"] = relationship(
        "ServicePattern",
        back_populates="pattern_edges",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="pattern_edges",
    )