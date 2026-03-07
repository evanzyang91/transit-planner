package db

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect creates a new database connection pool with retry logic.
// It attempts to connect up to maxAttempts times with delay between attempts.
// Returns the pool and an error if connection fails.
func Connect(ctx context.Context, databaseURL string, maxAttempts int, delay time.Duration) (*pgxpool.Pool, error) {
	var pool *pgxpool.Pool
	var err error

	for i := 0; i < maxAttempts; i++ {
		connectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		pool, err = pgxpool.New(connectCtx, databaseURL)
		cancel()

		if err != nil {
			log.Printf("Attempt %d: Unable to connect to database: %v", i+1, err)
			if i < maxAttempts-1 {
				time.Sleep(delay)
			}
			continue
		}

		if err := pool.Ping(ctx); err != nil {
			log.Printf("Attempt %d: Database not ready: %v", i+1, err)
			pool.Close()
			if i < maxAttempts-1 {
				time.Sleep(delay)
			}
			continue
		}

		log.Println("Database connected")
		return pool, nil
	}

	return nil, err
}

// ConnectWithDefaults creates a new database connection pool with default retry settings.
// Defaults: 10 attempts, 2 second delay between attempts.
func ConnectWithDefaults(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return Connect(ctx, databaseURL, 10, 2*time.Second)
}
