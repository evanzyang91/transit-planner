package handlers

// ErrorResponse represents an error payload for Swagger docs and API responses.
type ErrorResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error"`
	Code    int    `json:"code"`
}