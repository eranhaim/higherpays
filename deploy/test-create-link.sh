#!/usr/bin/env bash
set -e
API=https://higherpays.com/api

LOGIN=$(curl -sS -X POST $API/auth/login -H 'Content-Type: application/json' \
  --data '{"email":"owner@higherpays.local","password":"change-me-please"}')
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
WSID=$(echo "$LOGIN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspaces"][0]["id"])')
echo "workspace: $WSID"

echo
echo "--- creators (first 2) ---"
CREATORS=$(curl -sS "$API/workspaces/$WSID/creators" \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WSID")
echo "$CREATORS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get("creators",[])[:2],indent=2,default=str))'
CID=$(echo "$CREATORS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["creators"][0]["id"])')

echo
echo "--- creating link (EUR 5) ---"
LINK=$(curl -sS -X POST "$API/workspaces/$WSID/links" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Workspace-Id: $WSID" \
  --data "{\"creatorId\":\"$CID\",\"pricingMode\":\"fixed\",\"amount\":5,\"currency\":\"EUR\",\"description\":\"test link\"}")
echo "$LINK" | python3 -m json.tool
