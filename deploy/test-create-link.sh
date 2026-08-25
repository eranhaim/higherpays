#!/usr/bin/env bash
# Manual smoke test: sign in, list accounts, create a live payment link.
# Creates a REAL link at the provider — point API at a non-production stack
# unless you mean it.
#
#   API=http://localhost:3000/api EMAIL=... PASSWORD=... ./deploy/test-create-link.sh
set -e
API=${API:-https://higherpays.com/api}
EMAIL=${EMAIL:-owner@higherpays.local}
PASSWORD=${PASSWORD:-change-me-please}

LOGIN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
WSID=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspaces"][0]["id"])')
echo "workspace: $WSID"

echo
echo "--- accounts (first 2) ---"
ACCOUNTS=$(curl -sS "$API/workspaces/$WSID/accounts" \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WSID")
echo "$ACCOUNTS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get("accounts",[])[:2],indent=2,default=str))'
ACCOUNT_ID=$(echo "$ACCOUNTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accounts"][0]["id"])')

echo
echo "--- creating link (EUR 5) ---"
curl -sS -X POST "$API/workspaces/$WSID/links" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-Id: $WSID" \
  --data "{\"accountId\":\"$ACCOUNT_ID\",\"pricingMode\":\"fixed\",\"amount\":5,\"currency\":\"EUR\",\"description\":\"test link\"}" \
  | python3 -m json.tool
