#!/usr/bin/env bash
# Test-only, GitHub-hosted disposable stack. Never link a hosted project.
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-issue201"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
cleanup() { cli stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = '2.114.0'
cli start --help >/dev/null
cli db reset --help >/dev/null
cli migration up --help >/dev/null
cli stop --help >/dev/null
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor,edge-runtime >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for disposable_secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$disposable_secret"; done
export SUPABASE_DB_URL="$DB_URL"
echo "DISPOSABLE_POSTGRES_VERSION=$(psql "$DB_URL" -Atqc 'show server_version')"
digest() { psql "$DB_URL" -Atqc "select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]')) from exam_delivery.attempts a"; }
for baseline in 20260920124528 20260921044626; do
  cli db reset --local --no-seed --version "$baseline"
  node scripts/test-issue201-expiry-foundation.mjs --seed-upgrade
  before="$(digest)"
  cli migration up --local
  test "$(digest)" = "$before"
  test "$(psql "$DB_URL" -Atqc 'select count(*) from exam_delivery.expiry_authority')" = 0
  test "$(psql "$DB_URL" -Atqc 'select enabled from exam_delivery.expiry_activation')" = f
  echo "UPGRADE_${baseline}_PRESERVATION=PASS"
done
cli db reset --local --no-seed
test "$(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations')" = 91
node scripts/test-issue201-expiry-foundation.mjs
# Reset removes fixture data/activation before running pre-existing regressions.
cli db reset --local --no-seed
for suite in backend_exam_delivery_generic_lifecycle.sql backend_exam_delivery_practice_history.sql backend_exam_delivery_runner.sql backend_exam_delivery_issue133_phase4b.sql backend_exam_delivery_issue133_phase5a.sql; do
  cli test db --local "$GITHUB_WORKSPACE/supabase/tests/$suite"
done
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node scripts/test-generic-protected-lifecycle-integration.mjs
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node scripts/test-protected-access-history-integration.mjs
node scripts/test-issue86-python-orchestration-integration.mjs
cli db lint --local --level warning
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then
  echo 'DISPOSABLE_CLEANUP=FAIL'; exit 1
fi
echo 'DISPOSABLE_CLEANUP=PASS'
