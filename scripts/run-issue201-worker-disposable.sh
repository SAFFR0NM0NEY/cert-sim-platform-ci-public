#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-issue201-worker"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
server_pid=''
cleanup() {
 if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
 cli stop --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
cli start --help >/dev/null
cli functions serve --help >/dev/null
cli db reset --help >/dev/null
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
mkdir -p "$workdir/supabase/functions"
cp -r supabase/functions/certsim-expiry-worker supabase/functions/certsim-protected-exam "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for disposable_secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$disposable_secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
for baseline in 20260920124528 20260921044626 20261012075404; do
 cli db reset --local --no-seed --version "$baseline"
 node scripts/test-issue201-expiry-foundation.mjs --seed-upgrade
 before="$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")"
 cli migration up --local
 test "$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")" = "$before"
 test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.expiry_authority')" = 0
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.expiry_worker_control')" = f
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.expiry_activation')" = f
 echo "WORKER_UPGRADE_${baseline}=PASS"
done
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 92
node scripts/test-issue201-review-corrections.mjs
cli db reset --local --no-seed
node scripts/test-issue201-expiry-foundation.mjs
cli db reset --local --no-seed
serve() {
 if test -n "$server_pid"; then kill -- "-$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
 # Pinned 2.114.0 serves all configured functions; it accepts no name argument.
 setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/worker.env" >"$RUNNER_TEMP/worker.log" 2>&1 &
 server_pid=$!
 ready=0
 for n in {1..40}; do
  if kill -0 "$server_pid" 2>/dev/null; then
   probe="$(curl -s -X POST -H "apikey: $SERVICE_ROLE_KEY" "$API_URL/functions/v1/certsim-expiry-worker" || true)"
   if grep -q 'CERTSIM_EXPIRY_WORKER_ENABLED=true' "$RUNNER_TEMP/worker.env"; then
    # Full zero-count DTO proves the enabled runtime reached the disabled DB
    # gate, rather than the default runtime's missing environment gate.
    if grep -q '"completed":0' <<< "$probe"; then ready=1; break; fi
   elif grep -q '"state":"disabled"' <<< "$probe"; then ready=1; break; fi
  fi
  sleep 1
 done
 if test "$ready" != 1; then
  echo 'WORKER_RUNTIME_READY=FAIL'
  # CLI startup diagnostics only; no function requests or credentials printed.
  sed -E 's/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/<opaque>/g' "$RUNNER_TEMP/worker.log" | tail -30
  exit 1
 fi
}
printf '' > "$RUNNER_TEMP/worker.env"
serve
node scripts/test-issue201-expiry-worker-integration.mjs --disabled-config
printf 'CERTSIM_EXPIRY_WORKER_ENABLED=false\n' > "$RUNNER_TEMP/worker.env"
serve
node scripts/test-issue201-expiry-worker-integration.mjs --disabled-config
printf 'CERTSIM_EXPIRY_WORKER_ENABLED=invalid\n' > "$RUNNER_TEMP/worker.env"
serve
node scripts/test-issue201-expiry-worker-integration.mjs --disabled-config
printf 'CERTSIM_EXPIRY_WORKER_ENABLED=true\n' > "$RUNNER_TEMP/worker.env"
serve
node scripts/test-issue201-expiry-worker-unit.mjs
node scripts/test-issue201-expiry-worker-integration.mjs
cli db reset --local --no-seed
for suite in backend_exam_delivery_generic_lifecycle.sql backend_exam_delivery_practice_history.sql backend_exam_delivery_runner.sql backend_exam_delivery_issue133_phase4b.sql backend_exam_delivery_issue133_phase5a.sql; do
 cli test db --local "$GITHUB_WORKSPACE/supabase/tests/$suite"
done
node scripts/test-generic-protected-lifecycle-integration.mjs
node scripts/test-protected-access-history-integration.mjs
node scripts/test-issue86-python-orchestration-integration.mjs
cli db lint --local --level warning
cleanup
server_pid=''
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo WORKER_DISPOSABLE_CLEANUP=PASS
