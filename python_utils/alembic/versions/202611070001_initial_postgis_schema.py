"""Initial PostGIS-enabled transit analytics schema.

Revision ID: 202611070001
Revises:
Create Date: 2026-11-07 00:01:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from geoalchemy2 import Geometry

# revision identifiers, used by Alembic.
revision = "202611070001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Ensure PostGIS is available before creating spatial columns/indexes.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "agencies",
        sa.Column("agency_id", sa.Text(), nullable=False),
        sa.Column("agency_name", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("agency_id", name="pk_agencies"),
    )

    op.create_table(
        "time_buckets",
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("day_type", sa.Text(), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=False),
        sa.Column("end_time", sa.Time(), nullable=False),
        sa.PrimaryKeyConstraint("bucket_id", name="pk_time_buckets"),
    )

    op.create_table(
        "scenarios",
        sa.Column("scenario_id", sa.UUID(), nullable=False),
        sa.Column("scenario_name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("scenario_id", name="pk_scenarios"),
    )

    op.create_table(
        "stops",
        sa.Column("stop_pk", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("agency_id", sa.Text(), nullable=False),
        sa.Column("stop_id", sa.Text(), nullable=False),
        sa.Column("stop_name", sa.Text(), nullable=True),
        sa.Column("geom", Geometry("POINT", srid=4326), nullable=False),
        sa.ForeignKeyConstraint(
            ["agency_id"],
            ["agencies.agency_id"],
            name="fk_stops_agency_id_agencies",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("stop_pk", name="pk_stops"),
        sa.UniqueConstraint("agency_id", "stop_id", name="uq_stops_agency_stop_id"),
    )
    op.create_index("ix_stops_agency_id", "stops", ["agency_id"], unique=False)
    op.create_index(
        "ix_stops_geom",
        "stops",
        ["geom"],
        unique=False,
        postgresql_using="gist",
    )

    op.create_table(
        "routes",
        sa.Column("route_pk", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("agency_id", sa.Text(), nullable=False),
        sa.Column("route_id", sa.Text(), nullable=False),
        sa.Column("route_short_name", sa.Text(), nullable=True),
        sa.Column("route_long_name", sa.Text(), nullable=True),
        sa.Column("route_type", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["agency_id"],
            ["agencies.agency_id"],
            name="fk_routes_agency_id_agencies",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("route_pk", name="pk_routes"),
        sa.UniqueConstraint("agency_id", "route_id", name="uq_routes_agency_id_route_id"),
    )

    op.create_table(
        "service_patterns",
        sa.Column("pattern_pk", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("route_pk", sa.BigInteger(), nullable=False),
        sa.Column("direction_id", sa.Integer(), nullable=True),
        sa.Column("pattern_hash", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["route_pk"],
            ["routes.route_pk"],
            name="fk_service_patterns_route_pk_routes",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("pattern_pk", name="pk_service_patterns"),
        sa.UniqueConstraint("route_pk", "pattern_hash", name="uq_service_patterns_route_hash"),
    )
    op.create_index(
        "ix_service_patterns_route_pk",
        "service_patterns",
        ["route_pk"],
        unique=False,
    )

    op.create_table(
        "network_edges",
        sa.Column("edge_pk", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("from_stop_pk", sa.BigInteger(), nullable=False),
        sa.Column("to_stop_pk", sa.BigInteger(), nullable=False),
        sa.Column("geom", Geometry("LINESTRING", srid=4326), nullable=False),
        sa.Column("length_m", sa.Float(precision=53), nullable=True),
        sa.ForeignKeyConstraint(
            ["from_stop_pk"],
            ["stops.stop_pk"],
            name="fk_network_edges_from_stop_pk_stops",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["to_stop_pk"],
            ["stops.stop_pk"],
            name="fk_network_edges_to_stop_pk_stops",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("edge_pk", name="pk_network_edges"),
        sa.UniqueConstraint(
            "from_stop_pk",
            "to_stop_pk",
            name="uq_network_edges_from_stop_pk_to_stop_pk",
        ),
    )
    op.create_index(
        "ix_network_edges_from_stop_pk",
        "network_edges",
        ["from_stop_pk"],
        unique=False,
    )
    op.create_index(
        "ix_network_edges_to_stop_pk",
        "network_edges",
        ["to_stop_pk"],
        unique=False,
    )
    op.create_index(
        "ix_network_edges_geom",
        "network_edges",
        ["geom"],
        unique=False,
        postgresql_using="gist",
    )

    op.create_table(
        "pattern_stops",
        sa.Column("pattern_pk", sa.BigInteger(), nullable=False),
        sa.Column("stop_sequence", sa.Integer(), nullable=False),
        sa.Column("stop_pk", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pattern_pk"],
            ["service_patterns.pattern_pk"],
            name="fk_pattern_stops_pattern_pk_service_patterns",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["stop_pk"],
            ["stops.stop_pk"],
            name="fk_pattern_stops_stop_pk_stops",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("pattern_pk", "stop_sequence", name="pk_pattern_stops"),
    )
    op.create_index("ix_pattern_stops_stop_pk", "pattern_stops", ["stop_pk"], unique=False)

    op.create_table(
        "pattern_edges",
        sa.Column("pattern_pk", sa.BigInteger(), nullable=False),
        sa.Column("edge_order", sa.Integer(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pattern_pk"],
            ["service_patterns.pattern_pk"],
            name="fk_pattern_edges_pattern_pk_service_patterns",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_pattern_edges_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("pattern_pk", "edge_order", name="pk_pattern_edges"),
    )
    op.create_index("ix_pattern_edges_edge_pk", "pattern_edges", ["edge_pk"], unique=False)

    op.create_table(
        "edge_service_summary",
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.Column("route_pk", sa.BigInteger(), nullable=False),
        sa.Column("trips_operated", sa.Integer(), nullable=False),
        sa.Column("seats_supplied", sa.Numeric(), nullable=True),
        sa.Column("crush_capacity_supplied", sa.Numeric(), nullable=True),
        sa.Column("avg_headway_min", sa.Numeric(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_edge_service_summary_bucket_id_time_buckets",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_edge_service_summary_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["route_pk"],
            ["routes.route_pk"],
            name="fk_edge_service_summary_route_pk_routes",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_service_summary",
        ),
    )

    op.create_table(
        "stop_demand_summary",
        sa.Column("stop_demand_pk", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("stop_pk", sa.BigInteger(), nullable=False),
        sa.Column("route_pk", sa.BigInteger(), nullable=True),
        sa.Column("boardings", sa.Numeric(), nullable=True),
        sa.Column("alightings", sa.Numeric(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_stop_demand_summary_bucket_id_time_buckets",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["stop_pk"],
            ["stops.stop_pk"],
            name="fk_stop_demand_summary_stop_pk_stops",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["route_pk"],
            ["routes.route_pk"],
            name="fk_stop_demand_summary_route_pk_routes",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("stop_demand_pk", name="pk_stop_demand_summary"),
        sa.UniqueConstraint(
            "service_date",
            "bucket_id",
            "stop_pk",
            "route_pk",
            name="uq_stop_demand_summary_service_bucket_stop_route",
        ),
    )

    op.create_table(
        "edge_load_summary",
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.Column("route_pk", sa.BigInteger(), nullable=False),
        sa.Column("onboard_load_avg", sa.Numeric(), nullable=True),
        sa.Column("onboard_load_peak", sa.Numeric(), nullable=True),
        sa.Column("passenger_km", sa.Numeric(), nullable=True),
        sa.Column("load_source", sa.Text(), nullable=True),
        sa.Column("confidence_score", sa.Numeric(), nullable=True),
        sa.Column("estimation_method", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_edge_load_summary_bucket_id_time_buckets",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_edge_load_summary_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["route_pk"],
            ["routes.route_pk"],
            name="fk_edge_load_summary_route_pk_routes",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_load_summary",
        ),
    )

    op.create_table(
        "edge_burden_summary",
        sa.Column("service_date", sa.Date(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.Column("route_pk", sa.BigInteger(), nullable=False),
        sa.Column("onboard_load_peak", sa.Numeric(), nullable=True),
        sa.Column("seats_supplied", sa.Numeric(), nullable=True),
        sa.Column("crush_capacity_supplied", sa.Numeric(), nullable=True),
        sa.Column("load_factor_seated", sa.Numeric(), nullable=True),
        sa.Column("load_factor_crush", sa.Numeric(), nullable=True),
        sa.Column("burden_score", sa.Numeric(), nullable=True),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_edge_burden_summary_bucket_id_time_buckets",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_edge_burden_summary_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["route_pk"],
            ["routes.route_pk"],
            name="fk_edge_burden_summary_route_pk_routes",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "service_date",
            "bucket_id",
            "edge_pk",
            "route_pk",
            name="pk_edge_burden_summary",
        ),
    )

    op.create_table(
        "scenario_edge_capture",
        sa.Column("scenario_id", sa.UUID(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("capture_ratio", sa.Numeric(), nullable=False),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.scenario_id"],
            name="fk_scenario_edge_capture_scenario_id_scenarios",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_scenario_edge_capture_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_scenario_edge_capture_bucket_id_time_buckets",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "scenario_id",
            "edge_pk",
            "bucket_id",
            name="pk_scenario_edge_capture",
        ),
    )

    op.create_table(
        "scenario_proposed_edge_service",
        sa.Column("scenario_id", sa.UUID(), nullable=False),
        sa.Column("edge_pk", sa.BigInteger(), nullable=False),
        sa.Column("bucket_id", sa.Text(), nullable=False),
        sa.Column("trips_operated", sa.Integer(), nullable=True),
        sa.Column("crush_capacity_supplied", sa.Numeric(), nullable=True),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.scenario_id"],
            name="fk_scenario_proposed_edge_service_scenario_id_scenarios",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["edge_pk"],
            ["network_edges.edge_pk"],
            name="fk_scenario_proposed_edge_service_edge_pk_network_edges",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["bucket_id"],
            ["time_buckets.bucket_id"],
            name="fk_scenario_proposed_edge_service_bucket_id_time_buckets",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "scenario_id",
            "edge_pk",
            "bucket_id",
            name="pk_scenario_proposed_edge_service",
        ),
    )


def downgrade() -> None:
    op.drop_table("scenario_proposed_edge_service")
    op.drop_table("scenario_edge_capture")
    op.drop_table("edge_burden_summary")
    op.drop_table("edge_load_summary")
    op.drop_table("stop_demand_summary")
    op.drop_table("edge_service_summary")

    op.drop_index("ix_pattern_edges_edge_pk", table_name="pattern_edges")
    op.drop_table("pattern_edges")

    op.drop_index("ix_pattern_stops_stop_pk", table_name="pattern_stops")
    op.drop_table("pattern_stops")

    op.drop_index("ix_network_edges_geom", table_name="network_edges", postgresql_using="gist")
    op.drop_index("ix_network_edges_to_stop_pk", table_name="network_edges")
    op.drop_index("ix_network_edges_from_stop_pk", table_name="network_edges")
    op.drop_table("network_edges")

    op.drop_index("ix_service_patterns_route_pk", table_name="service_patterns")
    op.drop_table("service_patterns")

    op.drop_table("routes")

    op.drop_index("ix_stops_geom", table_name="stops", postgresql_using="gist")
    op.drop_index("ix_stops_agency_id", table_name="stops")
    op.drop_table("stops")

    op.drop_table("scenarios")
    op.drop_table("time_buckets")
    op.drop_table("agencies")