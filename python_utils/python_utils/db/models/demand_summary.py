from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.route import Route
    from python_utils.db.models.stop import Stop
    from python_utils.db.models.time_bucket import TimeBucket


class StopDemandSummary(Base):
    __tablename__ = "stop_demand_summary"
    __table_args__ = (
        UniqueConstraint(
            "service_date",
            "bucket_id",
            "stop_pk",
            "route_pk",
            name="uq_stop_demand_summary_service_bucket_stop_route",
        ),
    )

    stop_demand_pk: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        autoincrement=True,
    )
    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="RESTRICT"),
        nullable=False,
    )
    stop_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("stops.stop_pk", ondelete="RESTRICT"),
        nullable=False,
    )
    route_pk: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("routes.route_pk", ondelete="RESTRICT"),
        nullable=True,
    )
    boardings: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    alightings: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)

    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="stop_demand_summaries",
    )
    stop: Mapped["Stop"] = relationship(
        "Stop",
        back_populates="demand_summaries",
    )
    route: Mapped["Route | None"] = relationship(
        "Route",
        back_populates="stop_demand_summaries",
    )