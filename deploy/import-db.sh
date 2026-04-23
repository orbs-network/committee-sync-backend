#!/usr/bin/env bash
# Import a SQL dump into the deployed DB container.
# Usage: ./deploy/import-db.sh [path-to-sql-file]
# Defaults to deploy/db-export.sql if no argument given.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMPORT_FILE="${1:-${SCRIPT_DIR}/db-export.sql}"

if [ ! -f "${IMPORT_FILE}" ]; then
  echo "Error: ${IMPORT_FILE} not found."
  echo "Run ./deploy/export-db.sh on your dev machine first, then scp the file here."
  exit 1
fi

# Find the compose DB container
DB_CONTAINER=$(docker compose -f "${SCRIPT_DIR}/docker-compose.yml" ps -q db 2>/dev/null || true)
if [ -z "${DB_CONTAINER}" ]; then
  echo "Error: DB container not running. Start with: cd deploy && docker compose up -d db"
  exit 1
fi

echo "Importing ${IMPORT_FILE} into container ${DB_CONTAINER}..."
docker exec -i "${DB_CONTAINER}" psql -U postgres committee_sync < "${IMPORT_FILE}"

echo "Import complete."
