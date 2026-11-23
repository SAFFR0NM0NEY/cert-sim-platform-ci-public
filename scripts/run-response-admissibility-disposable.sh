#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
mode="${RESPONSE_CORRECTION_PHASE:-after}"
case "$mode" in before|after|full) ;; *) exit 1 ;; esac
workdir="$RUNNER_TEMP/certsim-response-admissibility"
original="$RUNNER_TEMP/certsim-response-original-source"
migration=20261027162647_issue214_variable_python_forms.sql
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
stop_server() {
  if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; server_pid=''; fi
}
cleanup() { stop_server; cli stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
mkdir -p "$original"
git archive 1b61d45d8fac26929aed47c00adb0c48974a2f6f | tar -x -C "$original"
test "$(sha256sum "$original/supabase/migrations/$migration" | cut -d' ' -f1)" = 1e7c76579e5320e7c1c85747de1dcd40e927c94568a54a7b8c67d18fba873ea5
export RESPONSE_ORIGINAL_SOURCE="$original"
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir" --through "${CERTSIM_VALIDATION_THROUGH:-20261027162647}"
if test "$mode" = before || test "$mode" = full; then cp "$original/supabase/migrations/$migration" "$workdir/supabase/migrations/$migration"; fi
mkdir -p "$workdir/supabase/functions"
cp -R supabase/functions/_shared supabase/functions/certsim-protected-exam supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
printf 'CERTSIM_RUNTIME_MODE=disposable-local\nCERTSIM_PROTECTED_RUNTIME_SECRET_KEY=%s\nCERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179\n' "$SERVICE_ROLE_KEY" > "$RUNNER_TEMP/response-runtime.env"
run_phase() {
  local response_phase="$1"
  stop_server
  if test "$response_phase" = before; then
    cp "$original/supabase/migrations/$migration" "$workdir/supabase/migrations/$migration"
    cp -R "$original/supabase/functions/_shared" "$original/supabase/functions/certsim-protected-exam" "$original/supabase/functions/certsim-expiry-worker" "$original/supabase/functions/certsim-python-expiry-worker" "$workdir/supabase/functions/"
  else
    cp "supabase/migrations/$migration" "$workdir/supabase/migrations/$migration"
    cp -R supabase/functions/_shared supabase/functions/certsim-protected-exam supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker "$workdir/supabase/functions/"
  fi
  cli db reset --local --no-seed
  test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = "${CERTSIM_VALIDATION_MIGRATIONS:-97}"
  timeout --kill-after=10s 240s node scripts/test-response-admissibility-database.mjs "--$response_phase"
  setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/response-runtime.env" >"$RUNNER_TEMP/response-$response_phase-runtime.log" 2>&1 &
  server_pid=$!
  local ready=0
  for n in {1..45}; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/certsim-protected-exam/eligibility" || true)"
    if test "$status" = 401; then ready=1; break; fi
    sleep 1
  done
  test "$ready" = 1
  export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
  RESPONSE_CORRECTION_PHASE="$response_phase" timeout --kill-after=10s 360s npx playwright test --config playwright.response-admissibility.config.js
  stop_server
}
if test "$mode" = before || test "$mode" = full; then run_phase before; fi
if test "$mode" = after || test "$mode" = full; then run_phase after; fi
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo RESPONSE_ADMISSIBILITY_DISPOSABLE_CLEANUP=PASS
