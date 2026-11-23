#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-variable-python"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
cleanup() {
  if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  cli stop --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir" --through "${CERTSIM_VALIDATION_THROUGH:-20261027162647}"
mkdir -p "$workdir/supabase/functions"
cp -r supabase/functions/_shared supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker supabase/functions/certsim-protected-exam "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for disposable_secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$disposable_secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = "${CERTSIM_VALIDATION_MIGRATIONS:-97}"
echo VARIABLE_FULL_REPLAY97=PASS
cli db reset --local --no-seed --version 20261016124752
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 96
timeout --kill-after=10s 180s node scripts/test-variable-python-upgrade.mjs --seed96
cli migration up --local
timeout --kill-after=10s 180s node scripts/test-variable-python-upgrade.mjs
timeout --kill-after=10s 180s node scripts/test-variable-python-database.mjs
timeout --kill-after=10s 180s node scripts/test-variable-python-upgrade.mjs
printf 'CERTSIM_RUNTIME_MODE=disposable-local\nCERTSIM_PROTECTED_RUNTIME_SECRET_KEY=%s\nCERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179\nCERTSIM_EXPIRY_WORKER_ENABLED=true\n' "$SERVICE_ROLE_KEY" > "$RUNNER_TEMP/variable-runtime.env"
setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/variable-runtime.env" > "$RUNNER_TEMP/variable-runtime.log" 2>&1 &
server_pid=$!
ready=0
for n in {1..40}; do
  probe="$(curl -s -X POST -H "apikey: $SERVICE_ROLE_KEY" "$API_URL/functions/v1/certsim-expiry-worker" || true)"
  if grep -q '"completed":0' <<< "$probe"; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
timeout --kill-after=10s 300s npx playwright test --config playwright.variable.config.js
timeout --kill-after=10s 180s node scripts/test-variable-python-expiry.mjs
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo VARIABLE_DISPOSABLE_CLEANUP=PASS
