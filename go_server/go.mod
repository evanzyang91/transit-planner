module hello-all-worlds/server

go 1.24.0

toolchain go1.24.13

require (
	github.com/gorilla/mux v1.8.1
	github.com/jackc/pgx/v5 v5.7.6
	github.com/joho/godotenv v1.5.1
	github.com/rs/cors v1.10.1
	hello-all-worlds v0.0.0
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.40.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/text v0.27.0 // indirect
)

replace hello-all-worlds => ../
