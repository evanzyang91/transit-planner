# transit-planner

This is meant to be an easy startup boilerplate for creating and deploying multi-lang applications with languages, message brokers, and DB of your framework.
Goal is to eventually support FE framework of your choice.
Includes support for Node & Next TS, Golang, Python, each with their own MongoDB, PostgreSQL, Redis, and Kafka.
And of course package management, db and message bus connectors/orms, and hot reload is built in to each application.
Applications are run directly from the shell of their directory but pull their .env from the root to make configuration easy.
DBs, message brokers are managed via docker and setup instructions a UI on each DB and message brokers are below.
Mono repo support is being considered for some langs as well.

---

## Install & run

**Prerequisites:** Node.js (for Express & web), Go 1.24+ (for Go), Python 3.11+ (for Python). Copy `.env.example` to `.env` at the repo root and set your DB/ports as needed.

| Stack    | Install | Run |
|----------|--------|-----|
| **Go**   | From repo root: `go work sync` (or `cd go_server && go mod download`) | `cd go_server && go run .` |
| **Python** | From repo root: `python -m venv .venv`, then activate venv and `pip install -e python_db -e python_utils` (and `pip install fastapi uvicorn` if using FastAPI) | From repo root with venv active: `python -m uvicorn python_server.api.main:app --reload` (or run the app module you use) |
| **Express** | From repo root: `npm install` (installs workspace deps including express_server) | `cd express_server && npm run dev` |
| **Web**  | From repo root: `npm install` | `npm run dev` (runs Next.js from `web/` with root `.env`) |
