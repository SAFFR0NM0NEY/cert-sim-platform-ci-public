#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
head="$(git rev-parse HEAD)"
root="$RUNNER_TEMP/certsim-container-initialization"
package="$root/package"
fixtures="$root/fixtures"
report="$root/package-report.json"
output="$RUNNER_TEMP/container-initialization.jsonl"
prefix="certsim-cold-import-${head:0:12}"
containers=()
cleanup() {
 for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
 if docker ps -a --format '{{.Names}}' | grep -Fq "$prefix-"; then
  echo CONTAINER_INITIALIZATION_CLEANUP=FAIL; return 1
 fi
 echo CONTAINER_INITIALIZATION_CLEANUP=PASS
}
trap cleanup EXIT
mkdir -p "$fixtures/original" "$fixtures/corrected"
node scripts/issue201-runtime-package.mjs stage "$head" "$package" fenced-v1 > "$report"
inventory="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).inventorySha256' "$report")"
export CERTSIM_TEST_PACKAGE_ROOT="$package" CERTSIM_TEST_PACKAGE_REPORT="$report"
# Exact pre-correction descriptor, not a hand-written imitation of the defect.
git cat-file blob 9ef3ca1eebe02f0e96d8d2560cb2b7ea3e8244aa:services/python-executor-modal/modal_fenced_app.py > "$fixtures/original/modal_fenced_app.py"
test "$(sha256sum "$fixtures/original/modal_fenced_app.py" | cut -d ' ' -f1)" = 4250b305f900c0c5b66c5961089e80096d92e03e27acfb37296bc6e30dafbc32
git cat-file blob "$head":services/python-executor-modal/modal_fenced_app.py > "$fixtures/corrected/modal_fenced_app.py"
cp scripts/test-issue201-container-bootstrap.py "$fixtures/bootstrap.py"
printf '// deliberately corrupted test module\n' > "$fixtures/corrupt-module.mjs"
printf '{}\n' > "$fixtures/corrupt-inventory.json"
python scripts/test-issue201-deployment-layout.py --fixtures "$fixtures" | tee "$output"
python scripts/test-issue201-deployment-layout.py --sdk "$fixtures" | tee -a "$output"
node scripts/issue201-runtime-package.mjs dockerfile "$package" "$inventory" > "$root/packaged.Dockerfile"
docker build --quiet -f "$root/packaged.Dockerfile" -t certsim-bootstrap-local:"$head" "$package"
# Test-only derived image. The release image/inventory acquire no test code or SDK.
docker build --quiet --build-arg BASE_IMAGE=certsim-bootstrap-local:"$head" -t certsim-bootstrap-sdk:"$head" - <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN python -m pip install --disable-pip-version-check --no-cache-dir modal==1.1.4
DOCKERFILE
for case in original-missing-builder original-stale-builder import stale-builder missing-hash missing-source wrong-hash wrong-source missing-inventory missing-module corrupt-module corrupt-inventory bootstrap; do
 descriptor="$fixtures/corrected/modal_fenced_app.py"
 if [[ "$case" == original-* ]]; then descriptor="$fixtures/original/modal_fenced_app.py"; fi
 name="$prefix-$case"
 containers+=("$name")
 args=(--rm --name "$name" --network none --read-only --tmpfs /tmp --workdir /tmp
       --mount "type=bind,src=$fixtures,dst=/harness,readonly"
       --mount "type=bind,src=$descriptor,dst=/root/modal_fenced_app.py,readonly")
 case "$case" in
  missing-inventory) args+=(--tmpfs /opt/certsim:ro);;
  missing-module) args+=(--tmpfs /opt/certsim/supabase/functions/_shared:ro);;
  corrupt-module) args+=(--mount "type=bind,src=$fixtures/corrupt-module.mjs,dst=/opt/certsim/supabase/functions/_shared/python-fence-auth.mjs,readonly");;
  corrupt-inventory) args+=(--mount "type=bind,src=$fixtures/corrupt-inventory.json,dst=/opt/certsim/RUNTIME_INVENTORY.json,readonly");;
 esac
 timeout --signal=TERM --kill-after=5s 35s docker run "${args[@]}" --entrypoint python certsim-bootstrap-sdk:"$head" -I -B /harness/bootstrap.py --case "$case" | tee -a "$output"
done
node scripts/issue201-runtime-package.mjs verify "$package" "$inventory" | tee -a "$output"
echo CONTAINER_INITIALIZATION_CASES=13 | tee -a "$output"
