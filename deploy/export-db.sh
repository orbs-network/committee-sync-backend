#!/usr/bin/env bash
# Export local dev DB to a SQL dump file for importing on the server.
# Usage: ./deploy/export-db.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORT_FILE="${SCRIPT_DIR}/db-export.sql"
CONTAINER_NAME="committee_sync_pg"

echo "Exporting from local container '${CONTAINER_NAME}'..."
docker exec "${CONTAINER_NAME}" pg_dump -U postgres committee_sync > "${EXPORT_FILE}"

echo "Exported to ${EXPORT_FILE} ($(wc -c < "${EXPORT_FILE}" | xargs) bytes)"
echo ""
echo "To deploy:"
echo "  1. scp ${EXPORT_FILE} <server>:~/committee-sync-backend/deploy/"
echo "  2. ssh <server> 'cd committee-sync-backend && ./deploy/import-db.sh'"
