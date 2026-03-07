# Port allocation

All apps and services use distinct ports so they can run together without conflicts.

## Applications (HTTP)

| App            | Default port | Env override | Notes                          |
|----------------|-------------:|--------------|--------------------------------|
| Web (Next.js)  |        3000  | `PORT`       | Dev and Dockerfile.web         |
| Express server |        3001  | `PORT`       | express_server                 |
| Python server  |        8000  | `PORT`       | FastAPI / python_server        |
| Go server      |        8010  | `PORT`       | Local dev default              |
| Go server      |        8080  | —            | When run via Dockerfile.server |

## Databases (docker-compose)

| Service   | Host port | Container port | Use for        |
|-----------|----------:|----------------|----------------|
| go-db     |      5433 | 5432           | Go/PostGIS     |
| python-db |      5434 | 5432           | Python         |
| ts-db     |      5435 | 5432           | Web / Prisma   |

Use the **host port** in connection strings when connecting from the host (e.g. `localhost:5435` for the web app).

## Message broker

| Service | Ports (host) | Notes   |
|---------|--------------|---------|
| Kafka   | 9092, 9093, 9094 | Single broker |

## Summary

- **3000** – Web  
- **3001** – Express  
- **8000** – Python server (FastAPI)  
- **8010** – Go server (local)  
- **8080** – Go server (Docker)  
- **5433** – Postgres (go-db)  
- **5434** – Postgres (python-db)  
- **5435** – Postgres (ts-db / web)  
- **9092, 9093, 9094** – Kafka  

No two services share a port.
