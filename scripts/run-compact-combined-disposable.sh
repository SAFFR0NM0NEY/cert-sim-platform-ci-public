#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-compact-combined"
cli(){ npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
cleanup(){
 local code=$?
 if test "$code" != 0 && test -z "${CERTSIM_PRIVATE_CONTENT_ROOT:-}" && test -f "$RUNNER_TEMP/combined-runtime.log"; then
  tail -60 "$RUNNER_TEMP/combined-runtime.log"
 fi
 if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; cli stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
mkdir -p "$workdir/supabase/functions"
cp -R supabase/functions/_shared supabase/functions/certsim-protected-exam supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
cli db reset --local --no-seed --version 20261028170153
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 98
printf 'CERTSIM_RUNTIME_MODE=disposable-local\nCERTSIM_PROTECTED_RUNTIME_SECRET_KEY=%s\nCERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179\nCERTSIM_EXPIRY_WORKER_ENABLED=true\n' "$SERVICE_ROLE_KEY" > "$RUNNER_TEMP/combined-runtime.env"
setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/combined-runtime.env" > "$RUNNER_TEMP/combined-runtime.log" 2>&1 &
server_pid=$!
ready=0
for n in {1..45}; do if ! grep -q "Serving functions on" "$RUNNER_TEMP/combined-runtime.log"; then sleep 1; continue; fi; status="$(curl -s -X POST -H "apikey: $SERVICE_ROLE_KEY" -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/certsim-expiry-worker" || true)"; if test "$status" = 200; then ready=1; break; fi; sleep 1; done
test "$ready" = 1
if ! timeout --kill-after=10s 180s node scripts/test-compact-combined-database.mjs --before; then
 if test -z "${CERTSIM_PRIVATE_CONTENT_ROOT:-}"; then
  cat "$RUNNER_TEMP/combined-runtime.log"
  docker logs --tail 60 supabase_edge_runtime_certsim-backend-exam-delivery-validation 2>&1 || true
 fi
 exit 1
fi
cli migration up --local
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 99
sleep 2
timeout --kill-after=10s 300s node scripts/test-compact-combined-database.mjs
if test -z "${CERTSIM_PRIVATE_CONTENT_ROOT:-}"; then
 export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
 timeout --kill-after=10s 300s npx playwright test --config playwright.compact-combined.config.js
fi
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo COMBINED_DISPOSABLE_CLEANUP=PASS

