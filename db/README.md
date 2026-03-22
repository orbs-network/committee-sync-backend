# PostgreSQL (Docker)

Run PostgreSQL locally for the committee-sync backend.

## Start

```bash
./db/run.sh
```

Data is persisted in `db/data/`. The container uses `docker.env` for credentials.

## Stop

```bash
docker stop committee-sync-db
```

## Remove container (keeps data)

```bash
docker rm -f committee-sync-db
```

Data in `db/data/` persists. Run `./db/run.sh` again to start fresh.

## App connection

Add to your project `.env`:

```
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=committee_sync
```
