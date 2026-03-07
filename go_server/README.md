# Genghis Routing Management API

The Management API ("The Compiler") is the core backend service that generates daily board manifests by processing paid ads, vendor allocations, and geographic constraints into optimized playlists.

## Overview

This service runs nightly jobs to compile manifests for all digital signage boards, handles board synchronization requests, collects play logs for analytics, and serves media files via R2 presigned URLs.

## Architecture

### Key Components

- **Nightly Mixer** - Core algorithm that compiles daily manifests
- **Board Sync API** - Serves manifests to boards for download
- **Play Logs API** - Collects playback data from boards
- **Media API** - Serves presigned URLs for creative assets from R2
- **Cron Scheduler** - Manages background jobs and cleanup tasks

### Tech Stack

- **Language**: Go 1.21+
- **Database**: PostgreSQL with PostGIS extensions
- **HTTP Router**: Gorilla Mux
- **Database Layer**: sqlc for type-safe queries
- **Job Scheduling**: Robfig Cron
- **CORS**: rs/cors
- **Object Storage**: Cloudflare R2
- **Swagger**: swaggo/http-swagger

### Project Structure

```
server/
├── main.go                    # Application entry point
├── internal/
│   ├── compiler/              # Manifest compilation logic
│   │   ├── creatives.go       # Creative handling
│   │   ├── geojson.go         # GeoJSON/zone processing
│   │   ├── helpers.go         # Utility functions
│   │   ├── manifest_builder.go# Manifest construction
│   │   ├── mixer.go           # Ad mixing algorithm
│   │   └── types.go           # Compiler data types
│   ├── handlers/              # HTTP request handlers
│   │   ├── board_sync.go      # Board sync endpoints
│   │   ├── health.go          # Health check endpoints
│   │   ├── management.go      # Management/compile endpoints
│   │   ├── media.go           # R2 media serving
│   │   └── play_logs.go       # Play log ingestion
│   ├── scheduler/             # Cron job scheduling
│   │   └── cron.go            # Cron scheduler implementation
│   └── config/                # Configuration
│       └── config.go          # Environment config loader
├── docs/                      # Swagger documentation
└── tmp/                       # Temporary files
```

## Getting Started

### Prerequisites

- Go 1.21 or higher
- PostgreSQL with PostGIS
- Cloudflare R2 bucket (for media storage)
- Database migrations applied (see `/db/migrations/`)

### Installation

1. Clone and navigate to the server directory:
```bash
cd hello-all-worlds/server
```

2. Install dependencies:
```bash
go mod tidy
```

3. Set environment variables (or use `.env` file):
```bash
export DATABASE_URL="postgres://user:password@localhost:5432/genghis?sslmode=disable"
export SERVER_HOST_PORT="8080"
export PUBLIC_URL="https://roamad.ca/api/cnc"

# R2 Configuration
export R2_ACCOUNT_ID="your_account_id"
export R2_ACCESS_KEY_ID="your_access_key"
export R2_SECRET_ACCESS_KEY="your_secret_key"
export R2_BUCKET_NAME="your_bucket_name"
```

4. Run the server:
```bash
go run main.go
```

## API Endpoints

**Base Path:** `/api/cnc`

### Health Check
- `GET /health` - Service health status

### Board Sync (for digital signage boards)
- `GET /api/cnc/v1/board/sync?device_id=XYZ` - Get manifest download URL
- `GET /api/cnc/v1/board/manifest?device_id=XYZ&date=2024-01-15` - Direct manifest download
- `POST /api/cnc/v1/board/logs` - Submit play logs

### Media (R2 Presigned URLs)
- `GET /api/cnc/v1/media/{id}` - Get presigned URL for media by ID
- `GET /api/cnc/v1/media/{id}/stream` - Stream media directly from R2

### Management API (internal)
- `POST /api/cnc/v1/management/compile` - Trigger manual compilation
- `GET /api/cnc/v1/management/scheduler/status` - Get scheduler status
- `POST /api/cnc/v1/management/scheduler/trigger` - Trigger scheduler job
- `GET /api/cnc/v1/management/manifests` - List all manifests
- `GET /api/cnc/v1/management/manifests/{board_id}` - Get board-specific manifests

### Admin/Debug
- `GET /api/cnc/v1/admin/config` - Get current configuration
- `GET /api/cnc/v1/admin/stats` - Get system statistics

### Swagger Documentation
- `GET /swagger/index.html` - Interactive API documentation

## Configuration

### Environment Variables

Required:
- `DATABASE_URL` - PostgreSQL connection string

Optional:
- `SERVER_HOST_PORT` - HTTP server port (default: 8080)
- `PUBLIC_URL` - Public-facing URL (default: http://localhost:8080)
- `R2_ACCOUNT_ID` - Cloudflare R2 account ID
- `R2_ACCESS_KEY_ID` - R2 access key ID
- `R2_SECRET_ACCESS_KEY` - R2 secret access key
- `R2_BUCKET_NAME` - R2 bucket name
- `R2_PUBLIC_URL` - R2 public URL (optional)

### Ad Mixing Rules

The ad mixing behavior is configured in code within `internal/compiler/mixer.go`. Key parameters:

- **Time Blocks**: Different mixing rules for different times of day
- **Loop Duration**: How long each playlist loop runs (default: 2 minutes)
- **Priority Calculations**: How ad priorities are calculated

## Scheduled Jobs

The system runs several automated jobs:

### Nightly Compilation (2:00 AM daily)
- Generates manifests for all active boards
- Processes paid ads and vendor allocations
- Applies geographic and time-based constraints
- Publishes manifests for board download

### Daily Stats (1:00 AM daily)
- Calculates performance metrics
- Updates ad allocation summaries
- Prepares dashboard data

### Cleanup Tasks (3:00 AM Sundays)
- Removes old manifests (30+ days)
- Cleans up old play logs (90+ days)
- Maintains database performance

## Database Schema

### Key Tables

- `daily_board_manifests` - Generated playlist manifests
- `play_logs` - Board playback tracking
- `ad_with_priority` - Paid advertisements with priorities
- `vendor_allocations` - House ad allocations
- `boards` - Digital signage board configuration
- `creatives` - Creative assets with R2 asset links

### Manifest Structure

```json
{
  "board_id": "uuid",
  "date": "2024-01-15",
  "zones": {
    "default": {
      "zone_id": "default",
      "zone_name": "Default Zone",
      "time_blocks": [
        {
          "start_time": "2024-01-15T00:00:00Z",
          "end_time": "2024-01-15T08:00:00Z",
          "playlist": [
            {
              "ad_id": "uuid",
              "creative_url": "https://...",
              "duration_seconds": 30,
              "type": "house_ad",
              "priority": 40
            }
          ]
        }
      ]
    }
  },
  "loop_duration_seconds": 120
}
```

## Development

### Running Tests
```bash
go test ./...
```

### Manual Compilation
Trigger compilation for a specific date:
```bash
curl -X POST http://localhost:8080/api/cnc/v1/management/compile \
  -H "Content-Type: application/json" \
  -d '{"date": "2024-01-15"}'
```

### Viewing Logs
The service logs all compilation activities, errors, and performance metrics to stdout.

### Database Queries
All database interactions use sqlc-generated type-safe queries. See:
- `db/db/models.go` - Generated models
- `db/db/*.sql.go` - Generated query code

## Deployment

### Docker Support

The service can be containerized. Ensure database connectivity and proper environment variables are configured.

### Monitoring

- Health endpoints for load balancer checks
- Structured logging for monitoring systems
- Cron job status available via API
- Database connection monitoring

## Troubleshooting

### Common Issues

1. **Database Connection Errors**
   - Verify `DATABASE_URL` environment variable
   - Check database server accessibility
   - Ensure migrations are applied

2. **Media/R2 Errors**
   - Verify R2 credentials are configured
   - Check bucket exists and is accessible
   - Ensure creatives have `approved` status

3. **Compilation Failures**
   - Check logs for specific error messages
   - Verify board configuration and active status
   - Ensure ad data integrity

4. **Cron Jobs Not Running**
   - Check scheduler status via `/api/cnc/v1/management/scheduler/status`
   - Review server logs for cron errors
   - Verify server timezone configuration

### Performance Tuning

- Monitor manifest compilation times
- Review database query performance
- Adjust cleanup job schedules if needed
- Scale database connections as required

## Contributing

When adding new features:

1. Keep files under 150 lines when possible
2. Use type-safe sqlc queries for database access
3. Add appropriate error handling and logging
4. Update configuration documentation
5. Test with realistic data volumes
6. Keep swagger docs updated (`swag.yaml`)

## Support

For issues or questions:
- Check server logs first
- Use health endpoints to verify service status
- Review database query performance
- Monitor cron job execution
- See `/swagger/index.html` for API details
