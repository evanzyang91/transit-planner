from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from python_utils.python_utils.db.session import engine
from python_utils.python_utils.helpers import get_env_bool


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    print("Starting lifespan")
    my_bool = get_env_bool("")
    print(my_bool)

    # Verify DB connectivity at startup using shared SQLAlchemy engine
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1 FROM agencies LIMIT 1"))
        print("Database connection check succeeded")
    except SQLAlchemyError as exc:
        # Fail fast so deployment/runtime clearly signals DB misconfiguration
        raise RuntimeError("Database connection check failed during startup") from exc

    yield
    print("Ending lifespan")


app = FastAPI(title="Hello All Worlds - Python Server", lifespan=lifespan)

api_router = APIRouter()


@api_router.get("/health")
def health() -> dict:
    # Lightweight DB health check
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        db_status = "ok"
    except SQLAlchemyError:
        db_status = "error"

    return {"status": "ok", "database": db_status}


app.include_router(api_router)


@app.get("/")
def root() -> dict:
    # Root endpoint now verifies it can reach the shared DB engine
    try:
        with engine.connect() as connection:
            result = connection.execute(text("SELECT 1")).scalar_one()
        return {
            "message": "Hello from python_server",
            "database": "connected",
            "ping": int(result),
        }
    except SQLAlchemyError as exc:
        return {
            "message": "Hello from python_server",
            "database": "unavailable",
            "error": str(exc.__class__.__name__),
        }
