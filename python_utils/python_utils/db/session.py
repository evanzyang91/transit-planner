from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

# Load environment from repository root .env if present
# (safe in production; existing env vars win).
env_path = Path(__file__).resolve().parents[3] / ".env"
print(f"[env] Looking for .env at: {env_path}")
load_dotenv(env_path, override=False)


def _get_db_log_enabled() -> bool:
    raw = os.getenv("DB_CONNECTION_LOG", "1").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _get_database_url() -> str:
    value = os.getenv("DATABASE_URL_PYTHON_RIDERSHIP", "").strip()
    if not value:
        raise RuntimeError(
            "DATABASE_URL_PYTHON_RIDERSHIP is not set. "
            "Expected format: postgresql+psycopg://user:password@host:5432/database"
        )
    return value


def _get_sql_echo() -> bool:
    raw = os.getenv("SQL_ECHO", "0").strip().lower()
    return raw in {"1", "true", "yes", "on"}


DATABASE_URL: str = _get_database_url()

engine: Engine = create_engine(
    DATABASE_URL,
    echo=_get_sql_echo(),
    future=True,
    pool_pre_ping=True,
)


if _get_db_log_enabled():
    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection, connection_record) -> None:
        print("[db] New database connection established.")

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
)


def get_session() -> Session:
    """
    Return a new SQLAlchemy Session.

    Usage:
        session = get_session()
        try:
            ...
        finally:
            session.close()
    """
    return SessionLocal()


@contextmanager
def session_scope() -> Iterator[Session]:
    """
    Transactional session scope for scripts/services.

    - Commits on success
    - Rolls back on exception
    - Always closes the session
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
