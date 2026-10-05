#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_ID="$(date +%s)$$"
export SMOKE_DB="ffp_test_smoke_${RUN_ID}"
PG_BASE="${SMOKE_PG_URL:-postgres://127.0.0.1:5432}"
export DATABASE_URL="${PG_BASE}/${SMOKE_DB}"
export REDIS_URL="${SMOKE_REDIS_URL:-redis://127.0.0.1:6379/2}"
export REDIS_PREFIX="ffp_smoke_${RUN_ID}"
export API_PORT=4260 RELAY_PORT=4261 DASHBOARD_PORT=4262 SHOP_PORT=4263
export API_URL="http://127.0.0.1:${API_PORT}" RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
export DASHBOARD_URL="http://127.0.0.1:${DASHBOARD_PORT}" SHOP_URL="http://127.0.0.1:${SHOP_PORT}"
LOG_DIR="${ROOT}/.smoke/${RUN_ID}"
mkdir -p "$LOG_DIR"
PIDS=()

cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1 || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" >/dev/null 2>&1 || true
  done
  psql "${PG_BASE}/postgres" -qc "DROP DATABASE IF EXISTS \"${SMOKE_DB}\" WITH (FORCE)" >/dev/null 2>&1 || true
  redis-cli -u "$REDIS_URL" --scan --pattern "${REDIS_PREFIX}*" 2>/dev/null | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null 2>&1 || true
  rm -rf "${ROOT}/apps/dashboard/dist-smoke"
  if [ "$code" -eq 0 ]; then
    echo "smoke: PASSED (logs in ${LOG_DIR})"
  else
    echo "smoke: FAILED with exit code ${code}, logs in ${LOG_DIR}"
    tail -n 30 "$LOG_DIR"/*.log || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 120); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "smoke: ${name} is up"
      return 0
    fi
    sleep 0.5
  done
  echo "smoke: ${name} did not start" >&2
  return 1
}

for port in $API_PORT $RELAY_PORT $DASHBOARD_PORT $SHOP_PORT; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "smoke: port ${port} is already in use" >&2
    exit 1
  fi
done

echo "smoke: building (turbo cache makes this fast when nothing changed)"
pnpm turbo run build --filter=@ffp/api --filter=@ffp/relay --filter=@ffp/demo-shop --output-logs=errors-only >"$LOG_DIR/build.log" 2>&1

echo "smoke: creating database ${SMOKE_DB}, migrating and seeding"
node apps/api/dist/seed.js --reset >"$LOG_DIR/seed.log" 2>&1

WORKER_INTERVAL_MS=500 node apps/api/dist/main.js >"$LOG_DIR/api.log" 2>&1 &
PIDS+=($!)
node apps/relay/dist/main.js >"$LOG_DIR/relay.log" 2>&1 &
PIDS+=($!)
FLAGS_SERVER_KEY=srv-demo-production FLAGS_CLIENT_KEY=cli-demo-production node apps/demo-shop/dist/server.js >"$LOG_DIR/shop.log" 2>&1 &
PIDS+=($!)
(cd apps/dashboard && VITE_API_URL="$API_URL" pnpm exec vite build --outDir dist-smoke --emptyOutDir >"$LOG_DIR/dashboard-build.log" 2>&1)
(cd apps/dashboard && exec pnpm exec vite preview --outDir dist-smoke --port "$DASHBOARD_PORT" --host 127.0.0.1 --strictPort >"$LOG_DIR/dashboard.log" 2>&1) &
PIDS+=($!)

wait_for "${API_URL}/health" api
wait_for "${RELAY_URL}/health" relay
wait_for "${SHOP_URL}/health" demo-shop
wait_for "${DASHBOARD_URL}/" dashboard

node scripts/smoke.mjs
