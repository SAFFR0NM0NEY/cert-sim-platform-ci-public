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
# Keep this disposable stack off the runner's conventional Supabase ports.
# Only the generated temporary config changes; canonical source stays intact.
node --input-type=module - "$workdir/supabase/config.toml" <<'NODE'
import fs from 'node:fs';
const p=process.argv[2],s=fs.readFileSync(p,'utf8');
if(!s.includes('port = 54322')||!s.includes('shadow_port = 54320'))throw Error('DISPOSABLE_PORT_CONTRACT');
fs.writeFileSync(p,s.replace('[api]','[api]\nport = 55421').replace('port = 54322','port = 55422').replace('shadow_port = 54320','shadow_port = 55420'));
NODE
mkdir -p "$workdir/supabase/functions"
cp -r supabase/functions/_shared supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker supabase/functions/certsim-protected-exam "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for disposable_secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$disposable_secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
if test "${ISSUE201_FENCED_PYTHON_TESTS:-false}" = true; then
 node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs
 cli db reset --local --no-seed
 for uncertainty in unknown-primary unknown-probe unknown-provider unknown-pending legacy-held; do
  node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs "$uncertainty"
  cli db reset --local --no-seed
 done
fi
if test "${ISSUE201_RESUMABLE_PYTHON_TESTS:-false}" = true; then
 node --experimental-transform-types scripts/test-issue201-python-expiry-worker.mjs
 cli db reset --local --no-seed
fi
if test "${ISSUE201_PYTHON_EXPIRY_TESTS:-false}" = true; then
 node scripts/test-issue201-python-expiry-authority.mjs
 if test "${ISSUE201_FROZEN_REPRO_ONLY:-false}" = true; then exit 0; fi
 # Restore the pristine disabled state for all retained worker regressions.
 cli db reset --local --no-seed
fi
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
python_disabled="$(curl --fail -s -X POST -H "apikey: $SERVICE_ROLE_KEY" "$API_URL/functions/v1/certsim-python-expiry-worker")"
grep -q '"state":"disabled"' <<< "$python_disabled"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/certsim-python-expiry-worker")" = 401
test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.python_worker_jobs')" = 0
echo PYTHON_WORKER_DENO_ENTRYPOINT_DEFAULT_DISABLED=PASS
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
for baseline in 20260920124528 20260921044626 20261012075404 20261012124759 20261015155552 20261015201131; do
 cli db reset --local --no-seed --version "$baseline"
 node scripts/test-issue201-expiry-foundation.mjs --seed-upgrade
 before="$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")"
 lease_oid=''
 if test "$baseline" = 20261015155552; then lease_oid="$(psql "$DB_URL" -Atqc "select 'exam_delivery.check_python_expiry_lease(uuid,uuid)'::regprocedure::oid")"; fi
 cli migration up --local
 if test -n "$lease_oid"; then
  test "$(psql "$DB_URL" -Atqc "select 'exam_delivery.check_python_expiry_lease(uuid,uuid)'::regprocedure::oid")" = "$lease_oid"
  echo PYTHON_WORKER_LEASE_FUNCTION_IDENTITY_RETAINED=PASS
 fi
 test "$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")" = "$before"
 test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.expiry_authority')" = 0
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.expiry_worker_control')" = f
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.expiry_activation')" = f
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.python_expiry_control')" = f
 test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.python_expiry_capabilities')" = 0
 test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.python_worker_control')" = f
  test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.python_fence_control')" = f
  test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.python_fences')" = 0
  echo "WORKER_UPGRADE_${baseline}=PASS"
done
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 95
node scripts/test-issue201-review-corrections.mjs
cli db reset --local --no-seed
node scripts/test-issue201-expiry-foundation.mjs
cli db reset --local --no-seed
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
