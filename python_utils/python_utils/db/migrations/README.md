# Database Migrations (Alembic)

This directory documents migration workflow for the transit analytics PostgreSQL + PostGIS schema.

## Scope

Migrations manage database structures for:

- Core network: agencies, stops, routes, service patterns, pattern stops, network edges, pattern edges, time buckets
- Operational summaries: edge service, edge load, edge burden, stop demand
- Scenario analysis: scenarios and scenario edge tables

## Requirements

- Python 3.11+
- PostgreSQL 14+ (or compatible)
- PostGIS extension available in target database
- `DATABASE_URL` environment variable set

Example:

`postgresql+psycopg://transit_app:change_me@localhost:5432/transit_analytics`

## One-time setup (from `python_utils/`)

1. Create and activate virtual environment
2. Install package and dependencies
3. Copy `.env.example` to `.env` and set credentials

## Run migrations

From `python_utils/`:

- Upgrade to latest:
  - `alembic upgrade head`
- Show current revision:
  - `alembic current`
- Show migration history:
  - `alembic history`

From repo root (alternative):

- `alembic -c python_utils/alembic.ini upgrade head`

## Create a new revision

Autogenerate from ORM metadata:

- `alembic revision --autogenerate -m "describe change"`

Then review the generated file under `alembic/versions/` before applying.

## PostGIS note

Initial migration enables PostGIS with:

- `CREATE EXTENSION IF NOT EXISTS postgis;`

This typically requires a role with sufficient database privileges.

## Safety practices

- Never edit an already-applied migration in shared environments.
- Add a new forward migration for schema changes.
- Review constraint/index names for consistency (naming conventions are defined in `db/base.py`).
- Test upgrade/downgrade in a disposable database before production deployment.