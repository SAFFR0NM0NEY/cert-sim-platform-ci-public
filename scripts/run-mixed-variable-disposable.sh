#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-mixed-variable"
cli(){ npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
cleanup(){ if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; cli stop --no-backup >/dev/null 2>&1 || true; }
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
cli db reset --local --no-seed --version 20261027162647
timeout --kill-after=10s 180s node scripts/test-mixed-variable-upgrade.mjs
cli migration up --local
timeout --kill-after=10s 180s node scripts/test-mixed-variable-upgrade.mjs --after
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = "${CERTSIM_VALIDATION_MIGRATIONS:-98}"
printf 'CERTSIM_RUNTIME_MODE=disposable-local\nCERTSIM_PROTECTED_RUNTIME_SECRET_KEY=%s\nCERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179\nCERTSIM_EXPIRY_WORKER_ENABLED=true\n' "$SERVICE_ROLE_KEY" > "$RUNNER_TEMP/mixed-runtime.env"
setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/mixed-runtime.env" > "$RUNNER_TEMP/mixed-runtime.log" 2>&1 &
server_pid=$!
ready=0
for n in {1..45}; do status="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/certsim-protected-exam/eligibility" || true)"; if test "$status" = 401; then ready=1; break; fi; sleep 1; done
test "$ready" = 1
timeout --kill-after=10s 300s node scripts/test-mixed-variable-database.mjs
if test "${MIXED_ACCEPTANCE_SCOPE:-focused}" != focused; then
 export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
 timeout --kill-after=10s 300s npx playwright test --config playwright.mixed-variable.config.js
 timeout --kill-after=10s 180s node scripts/test-mixed-variable-expiry.mjs
fi
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo MIXED_DISPOSABLE_CLEANUP=PASS

