#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
mode="${PRACTICE_CORRECTION_PHASE:-after}"
case "$mode" in before|after|pair|full) ;; *) exit 1 ;; esac
workdir="$RUNNER_TEMP/certsim-practice-matching"
original="$RUNNER_TEMP/certsim-practice-original-source"
migration=20261027162647_issue214_variable_python_forms.sql
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
stop_server(){ if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; server_pid=''; fi; }
cleanup(){ stop_server; cli stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
mkdir -p "$original"
git archive f6ae1c4da1e1e0b40efeacf778fbc09fce0c5bf7 | tar -x -C "$original"
test "$(sha256sum "$original/supabase/migrations/$migration" | cut -d' ' -f1)" = 88baa16da09a074f2731f917550443903974c5e079f078b9d870673b5b0e0da1
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir" --through "${CERTSIM_VALIDATION_THROUGH:-20261027162647}"
if test "$mode" = before || test "$mode" = pair || test "$mode" = full; then cp "$original/supabase/migrations/$migration" "$workdir/supabase/migrations/$migration"; fi
mkdir -p "$workdir/supabase/functions"
cp -R supabase/functions/_shared supabase/functions/certsim-protected-exam supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
printf 'CERTSIM_RUNTIME_MODE=disposable-local\nCERTSIM_PROTECTED_RUNTIME_SECRET_KEY=%s\nCERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179\n' "$SERVICE_ROLE_KEY" > "$RUNNER_TEMP/practice-runtime.env"
run_phase(){
 local phase="$1"
 stop_server
 local source='.'
 if test "$phase" = before; then source="$original"; fi
 cp "$source/supabase/migrations/$migration" "$workdir/supabase/migrations/$migration"
 cp -R "$source/supabase/functions/_shared" "$source/supabase/functions/certsim-protected-exam" "$source/supabase/functions/certsim-expiry-worker" "$source/supabase/functions/certsim-python-expiry-worker" "$workdir/supabase/functions/"
 cli db reset --local --no-seed
 test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = "${CERTSIM_VALIDATION_MIGRATIONS:-97}"
 timeout --kill-after=10s 240s node scripts/test-practice-matching-database.mjs
 setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/practice-runtime.env" > "$RUNNER_TEMP/practice-$phase-runtime.log" 2>&1 &
 server_pid=$!
 local ready=0
 for n in {1..45}; do status="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/certsim-protected-exam/eligibility" || true)"; if test "$status" = 401; then ready=1; break; fi; sleep 1; done
 test "$ready" = 1
 export VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY"
 PRACTICE_CORRECTION_PHASE="$phase" timeout --kill-after=10s 720s npx playwright test --config playwright.practice-matching.config.js
 timeout --kill-after=10s 180s node scripts/verify-practice-matching-context.mjs "--$phase"
 stop_server
}
if test "$mode" = before || test "$mode" = pair || test "$mode" = full; then run_phase before; fi
if test "$mode" = after || test "$mode" = pair || test "$mode" = full; then run_phase after; fi
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo PRACTICE_MATCHING_DISPOSABLE_CLEANUP=PASS
