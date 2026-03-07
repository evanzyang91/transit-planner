from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, DateTime, ForeignKey, Numeric, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.network_edge import NetworkEdge
    from python_utils.db.models.time_bucket import TimeBucket


class Scenario(Base):
    __tablename__ = "scenarios"

    scenario_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    scenario_name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    edge_captures: Mapped[list["ScenarioEdgeCapture"]] = relationship(
        "ScenarioEdgeCapture",
        back_populates="scenario",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    proposed_edge_services: Mapped[list["ScenarioProposedEdgeService"]] = relationship(
        "ScenarioProposedEdgeService",
        back_populates="scenario",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ScenarioEdgeCapture(Base):
    __tablename__ = "scenario_edge_capture"

    scenario_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scenarios.scenario_id", ondelete="CASCADE"),
        primary_key=True,
    )
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        primary_key=True,
    )
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="CASCADE"),
        primary_key=True,
    )
    capture_ratio: Mapped[float] = mapped_column(Numeric, nullable=False)

    scenario: Mapped["Scenario"] = relationship(
        "Scenario",
        back_populates="edge_captures",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="scenario_edge_captures",
    )
    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="scenario_edge_captures",
    )


class ScenarioProposedEdgeService(Base):
    __tablename__ = "scenario_proposed_edge_service"

    scenario_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("scenarios.scenario_id", ondelete="CASCADE"),
        primary_key=True,
    )
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        primary_key=True,
    )
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="CASCADE"),
        primary_key=True,
    )
    trips_operated: Mapped[int | None] = mapped_column(nullable=True)
    crush_capacity_supplied: Mapped[float | None] = mapped_column(Numeric, nullable=True)

    scenario: Mapped["Scenario"] = relationship(
        "Scenario",
        back_populates="proposed_edge_services",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="scenario_proposed_edge_services",
    )
    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="scenario_proposed_edge_services",
    )