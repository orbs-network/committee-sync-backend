#!/usr/bin/env bash
# Start a dedicated Postgres container for local committee-sync-backend development.
# Host port 5434 is used to avoid conflicts with other Postgres instances (e.g. the
# tradfi timescaledb container on 5433). Match DB_PORT=5434 in .env.

set -euo pipefail

CONTAINER_NAME="committee_sync_pg"
HOST_PORT=5434
PG_PASSWORD="postgres"
PG_DB="committee_sync"
PG_IMAGE="postgres:15"

# If the container already exists, just (re)start it instead of creating a new one.
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "Container '$CONTAINER_NAME' is already running on host port $HOST_PORT."
    exit 0
  fi
  echo "Starting existing container '$CONTAINER_NAME'..."
  docker start "$CONTAINER_NAME"
else
  echo "Creating new container '$CONTAINER_NAME' on host port $HOST_PORT..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p "${HOST_PORT}:5432" \
    "$PG_IMAGE"
fi

echo
echo "Postgres ready at localhost:${HOST_PORT}"
echo "Make sure your .env has:"
echo "  DB_HOST=localhost"
echo "  DB_PORT=${HOST_PORT}"
echo "  DB_USER=postgres"
echo "  DB_PASSWORD=${PG_PASSWORD}"
echo "  DB_NAME=${PG_DB}"
