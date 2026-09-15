#!/bin/sh
set -eu

URL="${HIGHERPAYS_HEALTH_URL:-https://higherpays.com/api/health}"
ALERT_URL="${HIGHERPAYS_ALERT_WEBHOOK_URL:-}"
TMP="${TMPDIR:-/tmp}/higherpays-health.$$"
trap 'rm -f "$TMP"' EXIT

code=$(curl -sS -o "$TMP" -w '%{http_code}' --max-time 15 "$URL" || true)
body=$(cat "$TMP" 2>/dev/null || true)

if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok":true'; then
  exit 0
fi

message="HigherPays health check failed: HTTP ${code:-none} ${body}"
printf '%s\n' "$message" >&2
if [ -n "$ALERT_URL" ]; then
  curl -sS --max-time 10 -X POST "$ALERT_URL" \
    -H 'Content-Type: application/json' \
    --data "{\"text\":\"${message}\"}" >/dev/null || true
fi
exit 1
