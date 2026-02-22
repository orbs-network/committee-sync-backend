#!/usr/bin/env bash
# Run PostgreSQL in Docker with persistent volume.
# Usage: ./db/run.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/data"

mkdir -p "$DATA_DIR"

docker run  \
  -d \
  --name committee-sync-db \
  --env-file "${SCRIPT_DIR}/docker.env" \
  -v "${DATA_DIR}:/var/lib/postgresql/data" \
  -p 5432:5432 \
  postgres:16

echo "PostgreSQL started. Data persisted in db/data/"
echo "Connect with: psql -h localhost -U postgres -d committee_sync"
