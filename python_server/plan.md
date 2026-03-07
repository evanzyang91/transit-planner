You are setting up the database layer for a transit network analytics app.

Goal:
Create a production-ready PostgreSQL + PostGIS schema and Python migration setup for a system that models:
1. Canadian transit networks from GTFS-style data
2. stop-to-stop directed network edges
3. route patterns
4. service supply by time bucket
5. ridership/load/burden by edge
6. scenario analysis for proposed new lines

Tech requirements:
- Python
- SQLAlchemy 2.x ORM/core
- Alembic for migrations
- PostgreSQL
- PostGIS
- psycopg (v3) or psycopg2, but prefer psycopg v3
- Use UUIDs where helpful for scenario tables, but bigserial is acceptable for static core network tables
- Organize code cleanly for long-term maintainability
- Avoid Supabase-specific features; plain Postgres only
- All schema objects should be portable to normal hosted/self-managed Postgres

Project requirements:
Create the following structure:

transit_app/
  pyproject.toml
  .env.example
  alembic.ini
  app/
    __init__.py
    db/
      __init__.py
      base.py
      session.py
      models/
        __init__.py
        agency.py
        stop.py
        route.py
        service_pattern.py
        network_edge.py
        time_bucket.py
        service_summary.py
        demand_summary.py
        scenario.py
      migrations/
        README.md
  alembic/
    env.py
    script.py.mako
    versions/

What I want implemented:

1. Python dependency setup
- SQLAlchemy 2.x
- Alembic
- psycopg
- python-dotenv
- GeoAlchemy2
- pydantic optional if useful, but not required

2. Database configuration
- session.py should load DATABASE_URL from environment
- provide engine, SessionLocal/sessionmaker, and Base import path
- support local development against postgres://...
- no async needed

3. SQLAlchemy declarative models for these tables

Core static network:
- agencies
- stops
- routes
- service_patterns
- pattern_stops
- network_edges
- pattern_edges
- time_buckets

Operational summaries:
- edge_service_summary
- stop_demand_summary
- edge_load_summary
- edge_burden_summary

Scenario analysis:
- scenarios
- scenario_edge_capture
- scenario_proposed_edge_service

Detailed schema expectations:

agencies:
- agency_id text primary key
- agency_name text not null

stops:
- stop_pk bigserial primary key
- agency_id text fk -> agencies.agency_id not null
- stop_id text not null
- stop_name text nullable
- geom geometry(Point, 4326) not null
- unique(agency_id, stop_id)
- gist index on geom

routes:
- route_pk bigserial primary key
- agency_id text fk -> agencies.agency_id not null
- route_id text not null
- route_short_name text nullable
- route_long_name text nullable
- route_type integer nullable
- unique(agency_id, route_id)

service_patterns:
- pattern_pk bigserial primary key
- route_pk bigint fk -> routes.route_pk not null
- direction_id integer nullable
- pattern_hash text not null
- unique(route_pk, pattern_hash)

pattern_stops:
- pattern_pk bigint fk -> service_patterns.pattern_pk not null
- stop_sequence integer not null
- stop_pk bigint fk -> stops.stop_pk not null
- composite primary key(pattern_pk, stop_sequence)

network_edges:
- edge_pk bigserial primary key
- from_stop_pk bigint fk -> stops.stop_pk not null
- to_stop_pk bigint fk -> stops.stop_pk not null
- geom geometry(LineString, 4326) not null
- length_m double precision nullable
- unique(from_stop_pk, to_stop_pk)
- gist index on geom

pattern_edges:
- pattern_pk bigint fk -> service_patterns.pattern_pk not null
- edge_order integer not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- composite primary key(pattern_pk, edge_order)

time_buckets:
- bucket_id text primary key
- day_type text not null
- start_time time not null
- end_time time not null

edge_service_summary:
- service_date date not null
- bucket_id text fk -> time_buckets.bucket_id not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- route_pk bigint fk -> routes.route_pk not null
- trips_operated integer not null
- seats_supplied numeric nullable
- crush_capacity_supplied numeric nullable
- avg_headway_min numeric nullable
- composite primary key(service_date, bucket_id, edge_pk, route_pk)

stop_demand_summary:
- service_date date not null
- bucket_id text fk -> time_buckets.bucket_id not null
- stop_pk bigint fk -> stops.stop_pk not null
- route_pk bigint fk -> routes.route_pk nullable
- boardings numeric nullable
- alightings numeric nullable
- composite primary key(service_date, bucket_id, stop_pk, route_pk)

Important note for stop_demand_summary:
Because route_pk is nullable and nullable columns in composite PKs are awkward, make a design decision that is production-safe.
Preferred:
- keep route_pk nullable as a normal column
- add a surrogate bigint primary key called stop_demand_pk
- add a unique constraint on (service_date, bucket_id, stop_pk, route_pk)
Apply similarly anywhere a nullable column would make a composite PK problematic.

edge_load_summary:
- service_date date not null
- bucket_id text fk -> time_buckets.bucket_id not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- route_pk bigint fk -> routes.route_pk not null
- onboard_load_avg numeric nullable
- onboard_load_peak numeric nullable
- passenger_km numeric nullable
- load_source text nullable
- confidence_score numeric nullable
- estimation_method text nullable
- composite primary key(service_date, bucket_id, edge_pk, route_pk)

edge_burden_summary:
- service_date date not null
- bucket_id text fk -> time_buckets.bucket_id not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- route_pk bigint fk -> routes.route_pk not null
- onboard_load_peak numeric nullable
- seats_supplied numeric nullable
- crush_capacity_supplied numeric nullable
- load_factor_seated numeric nullable
- load_factor_crush numeric nullable
- burden_score numeric nullable
- composite primary key(service_date, bucket_id, edge_pk, route_pk)

scenarios:
- scenario_id uuid primary key
- scenario_name text not null
- description text nullable
- created_at timestamptz not null default now()

scenario_edge_capture:
- scenario_id uuid fk -> scenarios.scenario_id not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- bucket_id text fk -> time_buckets.bucket_id not null
- capture_ratio numeric not null
- composite primary key(scenario_id, edge_pk, bucket_id)

scenario_proposed_edge_service:
- scenario_id uuid fk -> scenarios.scenario_id not null
- edge_pk bigint fk -> network_edges.edge_pk not null
- bucket_id text fk -> time_buckets.bucket_id not null
- trips_operated integer nullable
- crush_capacity_supplied numeric nullable
- composite primary key(scenario_id, edge_pk, bucket_id)

4. Relationships
- Add sensible SQLAlchemy relationship() definitions
- Keep model files separated by concern
- Ensure imports do not create circular dependency issues
- app/db/models/__init__.py should export all model classes for Alembic discovery

5. Alembic setup
- Configure Alembic for SQLAlchemy 2.x
- env.py should import Base metadata from app.db.base or equivalent
- Ensure all models are imported so autogenerate works
- Create an initial migration that:
  - enables extension postgis
  - creates all tables
  - creates unique constraints and foreign keys
  - creates GIST indexes on geom columns

6. Base and model conventions
- Use naming conventions for constraints/indexes in metadata so Alembic diffs are stable
- Put those conventions in base.py
- Use mapped_column, Mapped, DeclarativeBase style
- Add repr-friendly fields if helpful
- Keep types explicit and clean

7. PostGIS handling
- Use GeoAlchemy2 Geometry columns
- For stops.geom use Geometry("POINT", srid=4326)
- For network_edges.geom use Geometry("LINESTRING", srid=4326)

8. Deliverables
Generate all code files fully, not partial snippets.
I want:
- pyproject.toml
- .env.example
- base.py
- session.py
- every model file
- alembic env.py
- initial alembic migration
- helpful README note in app/db/migrations/README.md describing:
  - how to create DB
  - how to enable PostGIS if needed
  - how to run alembic upgrade head
  - how to autogenerate future migrations

9. Additional quality requirements
- Prefer clean, boring, production-friendly code over cleverness
- Do not use FastAPI or framework-specific code
- No repository pattern abstraction needed yet
- Keep the code directly usable by a Python ETL app
- Explain any design choices briefly in comments where they matter
- If there is a modeling issue with nullable composite PKs, fix it in the most robust way and mention it

10. After generating files, also output:
- exact shell commands to create a virtualenv, install deps, initialize alembic if needed, and run migrations
- exact commands for local Postgres setup example
- an example DATABASE_URL for local development

Please create the full implementation now.
