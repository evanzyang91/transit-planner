from __future__ import annotations

import os
import sys
import logging
from logging.config import fileConfig
from pathlib import Path

from dotenv import load_dotenv

from alembic import context
from sqlalchemy import engine_from_config, pool

# Resolve repository root and python package root.
# env.py location: <repo>/python_utils/alembic/env.py
REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Ensure project package root is importable when Alembic is run from python_utils/
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Load environment variables from repository root .env if present.
ENV_PATH = REPO_ROOT / ".env"
load_dotenv(ENV_PATH, override=False)

# this is the Alembic Config object, which provides
# access to values within the .ini file in use.
config = context.config

# Configure Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

logger = logging.getLogger("alembic.env")
logger.info("Alembic REPO_ROOT resolved to: %s", REPO_ROOT)
logger.info("Alembic PROJECT_ROOT resolved to: %s", PROJECT_ROOT)
logger.info("Alembic .env path resolved to: %s (exists=%s)", ENV_PATH, ENV_PATH.exists())

# Import metadata and model registry for autogenerate support.
from python_utils.db.base import Base  # noqa: E402
from python_utils.db import models  # noqa: F401,E402

target_metadata = Base.metadata


def get_database_url() -> str:
    """
    Resolve DB URL for Alembic in this order:
    1) DATABASE_URL_PYTHON_RIDERSHIP
    2) ALEMBIC_DATABASE_URL
    3) DATABASE_URL
    4) sqlalchemy.url from alembic.ini
    """
    url = (
        os.getenv("DATABASE_URL_PYTHON_RIDERSHIP")
        or os.getenv("ALEMBIC_DATABASE_URL")
        or os.getenv("DATABASE_URL")
    )
    if url:
        return url

    ini_url = config.get_main_option("sqlalchemy.url")
    if ini_url:
        return ini_url

    raise RuntimeError(
        "No database URL configured for Alembic. "
        "Set DATABASE_URL_PYTHON_RIDERSHIP, ALEMBIC_DATABASE_URL, or DATABASE_URL."
    )


def include_object(object_, name, type_, reflected, compare_to):
    """
    Hook for selectively including objects in autogenerate.
    Keep all objects for now.
    """
    return True


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = get_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        include_object=include_object,
        compare_type=True,
        compare_server_default=True,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=False,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = get_database_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            compare_type=True,
            compare_server_default=True,
            render_as_batch=False,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()