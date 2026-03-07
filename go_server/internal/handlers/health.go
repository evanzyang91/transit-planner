package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
)


// HealthHandler handles health check requests
type HealthHandler struct {
	db        *pgxpool.Pool
}

// NewHealthHandler creates a new health handler
func NewHealthHandler(dbPool *pgxpool.Pool, ) *HealthHandler {
	return &HealthHandler{
		db:        dbPool,
	}
}

// HealthResponse represents the health check response
type HealthResponse struct {
	Status     string            `json:"status"`
	Service    string            `json:"service"`
	Database   string            `json:"database"`
	Timestamp  string            `json:"timestamp"`
	Version    string            `json:"version"`
	Components map[string]string `json:"components"`
}

// GetHealth handles GET /health
// @Summary Health check endpoint
// @Description Returns the health status of the service and its dependencies
// @Tags health
// @Produce json
// @Success 200 {object} HealthResponse
// @Router /health [get]
func (h *HealthHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	status := "healthy"
	dbStatus := "disconnected"
	schedulerStatus := "stopped"

	// Check database
	if h.db != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := h.db.Ping(ctx); err != nil {
			dbStatus = "error"
			status = "degraded"
		} else {
			dbStatus = "connected"
		}
	} else {
		status = "degraded"
	}



	resp := HealthResponse{
		Status:    status,
		Service:   "genghis-management-api",
		Database:  dbStatus,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Version:   "1.0.0",
		Components: map[string]string{
			"compiler":   "active",
			"board_sync": "active",
			"play_logs":  "active",
			"scheduler":  schedulerStatus,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

// RegisterRoutes registers all health check routes
func (h *HealthHandler) RegisterRoutes(router *mux.Router) {
	router.HandleFunc("/health", h.GetHealth).Methods("GET")
}
