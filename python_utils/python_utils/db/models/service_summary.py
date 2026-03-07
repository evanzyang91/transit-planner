from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, ForeignKey, Integer, Numeric, PrimaryKeyConstraint, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from python_utils.db.base import Base

if TYPE_CHECKING:
    from python_utils.db.models.network_edge import NetworkEdge
    from python_utils.db.models.route import Route
    from python_utils.db.models.time_bucket import TimeBucket


class EdgeServiceSummary(Base):
    __tablename__ = "edge_service_summary"
    __table_args__ = (
        PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_service_summary",
        ),
    )

    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="RESTRICT"),
        nullable=False,
    )
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        nullable=False,
    )
    route_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("routes.route_pk", ondelete="CASCADE"),
        nullable=False,
    )

    trips_operated: Mapped[int] = mapped_column(Integer, nullable=False)
    seats_supplied: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    crush_capacity_supplied: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    avg_headway_min: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)

    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="edge_service_summaries",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="edge_service_summaries",
    )
    route: Mapped["Route"] = relationship(
        "Route",
        back_populates="edge_service_summaries",
    )


class EdgeLoadSummary(Base):
    __tablename__ = "edge_load_summary"
    __table_args__ = (
        PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_load_summary",
        ),
    )

    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="RESTRICT"),
        nullable=False,
    )
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        nullable=False,
    )
    route_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("routes.route_pk", ondelete="CASCADE"),
        nullable=False,
    )

    onboard_load_avg: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    onboard_load_peak: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    passenger_km: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    load_source: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence_score: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    estimation_method: Mapped[str | None] = mapped_column(Text, nullable=True)

    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="edge_load_summaries",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="edge_load_summaries",
    )
    route: Mapped["Route"] = relationship(
        "Route",
        back_populates="edge_load_summaries",
    )


class EdgeBurdenSummary(Base):
    __tablename__ = "edge_burden_summary"
    __table_args__ = (
        PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_burden_summary",
        ),
    )

    service_date: Mapped[date] = mapped_column(Date, nullable=False)
    bucket_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("time_buckets.bucket_id", ondelete="RESTRICT"),
        nullable=False,
    )
    edge_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("network_edges.edge_pk", ondelete="CASCADE"),
        nullable=False,
    )
    route_pk: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("routes.route_pk", ondelete="CASCADE"),
        nullable=False,
    )

    onboard_load_peak: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    seats_supplied: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    crush_capacity_supplied: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    load_factor_seated: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    load_factor_crush: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    burden_score: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)

    time_bucket: Mapped["TimeBucket"] = relationship(
        "TimeBucket",
        back_populates="edge_burden_summaries",
    )
    edge: Mapped["NetworkEdge"] = relationship(
        "NetworkEdge",
        back_populates="edge_burden_summaries",
    )
    route: Mapped["Route"] = relationship(
        "Route",
        back_populates="edge_burden_summaries",
    )