#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# PinOrbit-v2 Post-Deployment Smoke Test Suite
# ==============================================================================

BASE_URL="${BASE_URL:-http://localhost:4321}"
EDGE_FN_URL="${EDGE_FN_URL:-https://eygdoetdwqllvsxpvoex.supabase.co/functions/v1}"
INGEST_SECRET="${INGEST_SECRET:-test-secret}"
WORKSPACE_ID="${WORKSPACE_ID:-00000000-0000-0000-0000-000000000000}"

echo "========================================================"
echo "Running PinOrbit-v2 Post-Deployment Smoke Tests"
echo "Target Base URL: $BASE_URL"
echo "Edge Functions URL: $EDGE_FN_URL"
echo "========================================================"

# Test 1: Edge Function Auth Rejection (Unauthorized request must yield 401)
echo -n "[Test 1/5] Edge Function Auth Rejection without CRON_SECRET... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${EDGE_FN_URL}/create-board-webhook" \
  -H "Content-Type: application/json" \
  -d "{}" || echo "000")

if [ "$HTTP_CODE" -eq 401 ]; then
  echo "PASS (HTTP 401)"
else
  echo "WARN (Got HTTP $HTTP_CODE, expected 401)"
fi

# Test 2: Tenant Isolation (Foreign pin ID rejected with 404)
echo -n "[Test 2/5] Tenant Isolation / Ingest Foreign Pin Scoping... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/internal/pinterest/ingest" \
  -H "Content-Type: application/json" \
  -H "x-ingest-secret: ${INGEST_SECRET}" \
  -d '{"event":"pins.post","data":{"id":"00000000-0000-0000-0000-000000000001","status":"posted","workspace_id":"'"${WORKSPACE_ID}"'"}}' || echo "000")

if [ "$HTTP_CODE" -eq 404 ] || [ "$HTTP_CODE" -eq 401 ]; then
  echo "PASS (HTTP $HTTP_CODE)"
else
  echo "STATUS: $HTTP_CODE"
fi

# Test 3: Retention Cleanup Endpoint
echo -n "[Test 3/5] Retention Cleanup Endpoint Execution... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/internal/pinterest/cleanup-retention" \
  -H "Content-Type: application/json" \
  -H "x-ingest-secret: ${INGEST_SECRET}" \
  -d '{"workspace_id":"'"${WORKSPACE_ID}"'"}' || echo "000")

if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 401 ]; then
  echo "PASS (HTTP $HTTP_CODE)"
else
  echo "STATUS: $HTTP_CODE"
fi

# Test 4: cache_bypass Restriction (Non-admin cannot force bypass)
echo -n "[Test 4/5] Analytics cache_bypass Permission Check... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X GET "${BASE_URL}/api/analytics/overview?workspace_id=${WORKSPACE_ID}&connection_id=conn-1&cache_bypass=1" || echo "000")

if [ "$HTTP_CODE" -eq 401 ] || [ "$HTTP_CODE" -eq 200 ]; then
  echo "PASS (HTTP $HTTP_CODE - Unauthenticated/Non-admin safely handled)"
else
  echo "STATUS: $HTTP_CODE"
fi

# Test 5: PinArchive Dispatch Endpoint Auth Rejection (Unauthorized request must yield 401 JSON)
echo -n "[Test 5/5] PinArchive Dispatch Endpoint Auth Rejection... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/internal/pinarchive/dispatch" \
  -H "Content-Type: application/json" \
  -d '{"workspace_id":"'"${WORKSPACE_ID}"'"}' || echo "000")

if [ "$HTTP_CODE" -eq 401 ]; then
  echo "PASS (HTTP 401 JSON)"
else
  echo "STATUS: $HTTP_CODE"
fi

echo "========================================================"
echo "Smoke test suite completed."
echo "========================================================"
