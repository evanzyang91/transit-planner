from __future__ import annotations

import os
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL_PYTHON",
    "postgresql+psycopg://postgres:postgres@localhost:5434/genghis",
)


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, pool_pre_ping=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def check_connection() -> None:
    """Verify the database connection (e.g. on app startup)."""
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
        print("Database connection successful")