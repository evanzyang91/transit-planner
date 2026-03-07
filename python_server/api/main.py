from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from webbrowser import get

from fastapi import APIRouter, FastAPI

from python_db.python_db.database import check_connection
from python_utils.python_utils.helpers import get_env_bool

# Prefer the in-repo python_db (python_db/python_db) when run without pip install -e.


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    print("Starting lifespan")
    await asyncio.to_thread(check_connection)
    my_bool = get_env_bool("")
    print(my_bool)
    yield
    print("Ending lifespan")



app = FastAPI(title="Hello All Worlds - Python Server", lifespan=lifespan)

api_router = APIRouter()


@api_router.get("/health")
def health() -> dict:
    return {"status": "ok",  }


app.include_router(api_router)


@app.get("/")
def root() -> dict:
    return {"message": "Hello from python_server"}
