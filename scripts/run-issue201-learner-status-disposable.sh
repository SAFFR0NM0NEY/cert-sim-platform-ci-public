#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
workdir="$RUNNER_TEMP/certsim-issue201-learner-status"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
edge_pid='' vite_pid=''
cleanup() {
 for owned_pid in "$edge_pid" "$vite_pid"; do
  if test -n "$owned_pid"; then kill -- "-$owned_pid" 2>/dev/null || true; wait "$owned_pid" 2>/dev/null || true; fi
 done
 cli stop --no-backup >/dev/null 2>&1 || true
}
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
cli start --help >/dev/null
cli functions serve --help >/dev/null
cli migration up --help >/dev/null
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
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
for baseline in 20260920124528 20261016040546; do
 cli db reset --local --no-seed --version "$baseline"
 node scripts/test-issue201-expiry-foundation.mjs --seed-upgrade
 before="$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")"
 cli migration up --local
 test "$(psql "$DB_URL" -Atqc "select md5(jsonb_agg(to_jsonb(a) order by id)::text) from exam_delivery.attempts a")" = "$before"
 test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.expiry_authority')" = 0
 for gate in expiry_activation expiry_worker_control python_expiry_control python_worker_control python_fence_control; do
  test "$(psql "$DB_URL" -Atqc "select enabled from exam_delivery.$gate")" = f
 done
 test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 96
 echo "LEARNER_STATUS_UPGRADE_${baseline}=PASS"
done
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 96
cat > "$RUNNER_TEMP/learner-status.env" <<ENV
CERTSIM_RUNTIME_MODE=disposable-local
CERTSIM_PROTECTED_RUNTIME_SECRET_KEY=$SERVICE_ROLE_KEY
CERTSIM_ALLOWED_ORIGINS=http://127.0.0.1:4179
CERTSIM_EXPIRY_WORKER_ENABLED=true
CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED=false
CERTSIM_PYTHON_EXPIRY_FENCING_ENABLED=false
CERTSIM_PYTHON_EXPIRY_RECOVERY_ENABLED=false
ENV
setsid npx --yes supabase@2.114.0 --workdir "$workdir" functions serve --env-file "$RUNNER_TEMP/learner-status.env" > "$RUNNER_TEMP/learner-status-edge.log" 2>&1 &
edge_pid=$!
ready=0
for n in {1..45}; do
 if test "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/certsim-protected-exam/completion-status/pending" || true)" = 401; then ready=1; break; fi
 sleep 1
done
test "$ready" = 1
VITE_SUPABASE_URL="$API_URL" VITE_SUPABASE_ANON_KEY="$ANON_KEY" setsid node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4179 --strictPort > "$RUNNER_TEMP/learner-status-vite.log" 2>&1 &
vite_pid=$!
ready=0
for n in {1..30}; do
 if curl --fail -s "http://127.0.0.1:4179/tests/r3g/issue201-learner-status-harness.html" >/dev/null; then ready=1; break; fi
 sleep 1
done
test "$ready" = 1
node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs learner-status
# Probe the actual new Edge against old/new DB contracts with all gates disabled.
cli db reset --local --no-seed --version 20261016040546
psql "$DB_URL" -qc "notify pgrst,'reload schema'"
sleep 2
node scripts/test-issue201-status-version-skew.mjs --unsupported
cli migration up --local
psql "$DB_URL" -qc "notify pgrst,'reload schema'"
sleep 2
node scripts/test-issue201-status-version-skew.mjs
# New read-only functions cannot change the retained manual/foundation contracts.
cli db reset --local --no-seed
node scripts/test-issue201-review-corrections.mjs
cli db reset --local --no-seed
node scripts/test-issue201-expiry-foundation.mjs
cli db reset --local --no-seed
for suite in backend_exam_delivery_generic_lifecycle.sql backend_exam_delivery_practice_history.sql backend_exam_delivery_runner.sql backend_exam_delivery_issue133_phase4b.sql; do
 cli test db --local "$GITHUB_WORKSPACE/supabase/tests/$suite"
done
node scripts/test-generic-protected-lifecycle-integration.mjs
node scripts/test-protected-access-history-integration.mjs
node scripts/test-issue86-python-orchestration-integration.mjs
node scripts/issue201-learner-status-provenance.mjs
cleanup
edge_pid='' vite_pid=''
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo LEARNER_STATUS_DISPOSABLE_CLEANUP=PASS
