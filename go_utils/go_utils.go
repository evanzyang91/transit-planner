package go_utils

import (
	"os"
	"time"
)

// GetEnv returns the value of the environment variable key, or defaultValue if unset or empty.
func GetEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// FormatTimestamp formats a timestamp to a readable RFC3339 string.
func FormatTimestamp(t time.Time) string {
	return t.Format(time.RFC3339)
}
