#!/bin/sh
# HigherPays backend container entrypoint.
#
# 1. Wait for Postgres to accept connections.
# 2. Run migrations as the DB owner (MIGRATIONS_DATABASE_URL). DDL needs the
#    owner; the app never runs as this role.
# 3. Start the server as the restricted hp_app role (DATABASE_URL).
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set (runtime, hp_app role)}"
: "${MIGRATIONS_DATABASE_URL:?MIGRATIONS_DATABASE_URL must be set (owner role)}"

echo "[entrypoint] waiting for Postgres..."
# pg_isready pings the DB without needing full auth.
# We derive host+port from the URL so this works with any DB.
DB_HOST=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname);")
DB_PORT=$(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.port || '5432');")

until pg_isready -h "$DB_HOST" -p "$DB_PORT" -q; do
  sleep 1
done
echo "[entrypoint] Postgres reachable at ${DB_HOST}:${DB_PORT}."

echo "[entrypoint] applying migrations..."
DATABASE_URL="$MIGRATIONS_DATABASE_URL" node src/util/migrate.js

# The migrations create new tables owned by the migrations user; we already
# granted default privileges to hp_app in postgres-init.sql, so no extra
# GRANT step is needed here. Seeds only run on-demand (SEED_ON_BOOT=true).
if [ "${SEED_ON_BOOT:-false}" = "true" ]; then
  echo "[entrypoint] seeding database..."
  DATABASE_URL="$MIGRATIONS_DATABASE_URL" node src/util/seed.js || \
    echo "[entrypoint] seed failed (probably already seeded), continuing."
fi

echo "[entrypoint] starting API as $(node -e "const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.username);")..."
exec node src/server.js
