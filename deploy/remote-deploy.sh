#!/usr/bin/env bash
set -euo pipefail
cd /home/deploy/higherpays

previous=$(git rev-parse --short HEAD)
git fetch --quiet origin main
git pull --ff-only --quiet origin main
deployed=$(git rev-parse --short HEAD)

echo "previous: $previous -> deployed: $deployed"
git --no-pager log --oneline "$previous..$deployed" | head -5

COMPOSE=(docker compose -f docker-compose.yml)
if awk -F= '$1 == "DATABASE_URL" && length($2) > 0 { app = 1 } $1 == "MIGRATIONS_DATABASE_URL" && length($2) > 0 { migrations = 1 } END { exit !(app && migrations) }' .env; then
  COMPOSE+=(-f docker-compose.rds.yml)
fi

"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" ps

echo "waiting for health..."
for i in $(seq 1 15); do
  body=$(curl -fsS http://localhost:8083/api/health 2>/dev/null || true)
  if [ -n "$body" ]; then
    echo "health check: ok - deployed $deployed"
    exit 0
  fi
  sleep 2
done

echo "health check failed after 30s" >&2
curl -sS http://localhost:8083/api/health >&2 || true
"${COMPOSE[@]}" logs --tail 40 backend >&2
exit 1
