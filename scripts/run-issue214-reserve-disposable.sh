#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
workdir="$RUNNER_TEMP/certsim-issue214-reserves"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
cleanup() { cli stop --no-backup >/dev/null 2>&1 || true; }
trap cleanup EXIT
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
cli start --help >/dev/null
cli db reset --help >/dev/null
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
mkdir -p "$workdir/supabase/functions"
cp -r supabase/functions/_shared supabase/functions/certsim-expiry-worker supabase/functions/certsim-python-expiry-worker supabase/functions/certsim-protected-exam "$workdir/supabase/functions/"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
cli db reset --local --no-seed
node scripts/test-issue214-reserve-materialization.mjs
for suite in backend_exam_delivery_issue85_python_forms.sql backend_exam_delivery_issue21.sql backend_exam_delivery_issue21_compatibility.sql backend_exam_delivery_legacy_compatibility.sql backend_exam_delivery_issue83_partial_scorer.sql; do
 cli test db --local "$GITHUB_WORKSPACE/supabase/tests/$suite"
done
node scripts/test-issue21-canonical-form-lifecycle.mjs
cleanup
if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then exit 1; fi
echo ISSUE214_DISPOSABLE_CLEANUP=PASS
