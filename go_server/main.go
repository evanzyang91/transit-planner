package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	go_db "hello-all-worlds/go_db/db"
	go_utils "hello-all-worlds/go_utils"
	"hello-all-worlds/server/internal/handlers"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/cors"

	"github.com/joho/godotenv"
)

// @title Genghis Routing Management API
// @description Management API for Genghis Routing digital signage system
// @version 1.0.0
// @BasePath /

var (
	dbPool *pgxpool.Pool
)

func main() {
	log.Println("Starting Genghis Routing Management API server...")

	// Initialize database connection (.env at repo root; run from go_server dir)
	_ = godotenv.Load("../.env")
	databaseURL := go_utils.GetEnv("DATABASE_URL_GO", "")
	ctx := context.Background()
	var err error
	dbPool, err = go_db.ConnectWithDefaults(ctx, databaseURL)
	if err != nil {
		log.Fatalf("database connection: %v", err)
	}
	defer func() {
		if dbPool != nil {
			dbPool.Close()
			log.Println("Database connection closed")
		}
	}()

	// Setup HTTP router and handlers
	router := setupRoutes()

	// Setup CORS
	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"}, // Configure appropriately for production
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	})

	handler := c.Handler(router)

	// Setup server
	port := go_utils.GetEnv("PORT", "8010")

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		log.Printf("Server listening on port %s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	} else {
		log.Println("Server exited gracefully")
	}
}

func setupRoutes() *mux.Router {
	r := mux.NewRouter()

	// Health check handler
	healthHandler := handlers.NewHealthHandler(dbPool)
	healthHandler.RegisterRoutes(r)

	return r
}
