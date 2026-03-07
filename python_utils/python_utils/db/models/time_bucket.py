from __future__ import annotations

from datetime import time
from typing import TYPE_CHECKING

from sqlalchemy import String, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.demand_summary import StopDemandSummary
    from python_utils.db.models.scenario import (
        ScenarioEdgeCapture,
        ScenarioProposedEdgeService,
    )
    from python_utils.db.models.service_summary import (
        EdgeBurdenSummary,
        EdgeLoadSummary,
        EdgeServiceSummary,
    )


class TimeBucket(Base):
    __tablename__ = "time_buckets"

    bucket_id: Mapped[str] = mapped_column(String, primary_key=True)
    day_type: Mapped[str] = mapped_column(String, nullable=False)
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)

    edge_service_summaries: Mapped[list["EdgeServiceSummary"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )
    stop_demand_summaries: Mapped[list["StopDemandSummary"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )
    edge_load_summaries: Mapped[list["EdgeLoadSummary"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )
    edge_burden_summaries: Mapped[list["EdgeBurdenSummary"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )
    scenario_edge_captures: Mapped[list["ScenarioEdgeCapture"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )
    scenario_proposed_edge_services: Mapped[list["ScenarioProposedEdgeService"]] = relationship(
        back_populates="time_bucket",
        passive_deletes=True,
    )