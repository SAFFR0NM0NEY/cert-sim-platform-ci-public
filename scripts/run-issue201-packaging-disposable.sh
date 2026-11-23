#!/usr/bin/env bash
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
workdir="$RUNNER_TEMP/certsim-issue201-packaging"
report="$RUNNER_TEMP/packaged-fenced.json"
legacy_report="$RUNNER_TEMP/packaged-legacy.json"
package="$RUNNER_TEMP/certsim-fenced-package"
legacy="$RUNNER_TEMP/certsim-legacy-package"
cli() { npx --yes supabase@2.114.0 --workdir "$workdir" "$@"; }
cleanup() {
 cli stop --no-backup >/dev/null 2>&1 || true
 if docker ps -a --format '{{.Names}}' | grep -Eq '_certsim-backend-exam-delivery-validation$'; then
  echo PACKAGING_DISPOSABLE_CLEANUP=FAIL; return 1
 fi
 echo PACKAGING_DISPOSABLE_CLEANUP=PASS
}
trap cleanup EXIT
head="$(git rev-parse HEAD)"
node scripts/issue201-runtime-package.mjs stage "$head" "$package" fenced-v1 > "$report"
node scripts/issue201-runtime-package.mjs stage "$head" "$legacy" legacy > "$legacy_report"
inventory="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).inventorySha256' "$report")"
legacy_inventory="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).inventorySha256' "$legacy_report")"
export CERTSIM_TEST_PACKAGE_ROOT="$package" CERTSIM_TEST_PACKAGE_REPORT="$report" CERTSIM_TEST_LEGACY_REPORT="$legacy_report"
python scripts/test-issue201-deployment-layout.py
python scripts/test-issue201-deployment-layout.py --sdk
# Local Docker only: no Modal import/build/resource execution. Context copies
# are individual manifest paths, so host node_modules cannot enter the image.
node scripts/issue201-runtime-package.mjs dockerfile "$package" "$inventory" > "$RUNNER_TEMP/packaged.Dockerfile"
docker build --quiet -f "$RUNNER_TEMP/packaged.Dockerfile" -t certsim-packaged-local:"$head" "$package"
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint node certsim-packaged-local:"$head" --input-type=module -e "
 import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
 import {spawnSync} from 'node:child_process';import {ModalClient} from 'modal';
 import './src/fenced-service.mjs';import {createFencedProfileServer} from './src/fenced-start.mjs';
 const secret=()=>randomBytes(32).toString('hex');
 const env={MODAL_TOKEN_ID:secret(),MODAL_TOKEN_SECRET:secret(),CERTSIM_EXECUTION_SIGNING_SECRET:secret(),CERTSIM_GRADING_SIGNING_SECRET:secret(),CERTSIM_EXPIRY_V1_SIGNING_SECRET:secret(),CERTSIM_FENCE_STORE_SERVICE_KEY:secret(),CERTSIM_FENCE_STORE_URL:'http://127.0.0.1:1',CERTSIM_PYTHON_FENCE_PROTOCOL:'certsim.python-expiry.fence.v1'};
 const server=createFencedProfileServer({env});assert.equal(server.timeout,150000);assert.equal(server.requestTimeout,15000);
 assert.equal(process.versions.node.split('.')[0],'22');assert.match(spawnSync('python3',['--version'],{encoding:'utf8'}).stdout,/Python 3.12/);
 const sdk=new ModalClient({tokenId:secret(),tokenSecret:secret(),logLevel:'error'});assert.equal(sdk.version(),'0.10.1');sdk.close();
 console.log(JSON.stringify({suite:'packaged-local-linux-image',node:process.versions.node,python:'3.12',moduleGraph:true,hostedModal:false,network:'none',passed:true}));
"
npm --prefix "$package/services/python-executor-modal" ci --omit=dev --ignore-scripts --prefer-offline
npm --prefix "$legacy/services/python-executor-modal" ci --omit=dev --ignore-scripts --prefer-offline
node --experimental-transform-types scripts/test-issue201-runtime-package.mjs
chmod -R a-w "$package" "$legacy"
# The original 95 migrations/hashes remain frozen. Replay the proven2.114 lane.
test "$(npx --yes supabase@2.114.0 --version)" = 2.114.0
node scripts/supabase-migration-validation/prepare-migrations.mjs --set assignment --output "$workdir"
node scripts/issue201-runtime-package.mjs worker-config "$package" "$inventory" > "$workdir/supabase/config.toml"
node --input-type=module - "$workdir/supabase/config.toml" <<'NODE'
import fs from 'node:fs';
const p=process.argv[2],s=fs.readFileSync(p,'utf8');
if(!s.includes('port = 54322')||!s.includes('shadow_port = 54320'))throw Error('DISPOSABLE_PORT_CONTRACT');
fs.writeFileSync(p,s.replace('[api]','[api]\nport = 55421').replace('port = 54322','port = 55422').replace('shadow_port = 54320','shadow_port = 55420'));
NODE
mkdir -p "$workdir/supabase/functions"
# Only inventoried staged worker code; no whole checkout/function directory.
cp -R "$package/supabase/functions/." "$workdir/supabase/functions/"
chmod -R a-w "$workdir/supabase/functions"
cli start --exclude studio,imgproxy,mailpit,storage-api,realtime,logflare,vector,supavisor >/dev/null
set -a
eval "$(cli status -o env)"
set +a
for disposable_secret in "$DB_URL" "$ANON_KEY" "$SERVICE_ROLE_KEY"; do echo "::add-mask::$disposable_secret"; done
export SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs
cli db reset --local --no-seed
for uncertainty in unknown-primary unknown-provider; do
 node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs "$uncertainty"
 cli db reset --local --no-seed
done
export CERTSIM_TEST_EDGE_WORKDIR="$workdir"
node --experimental-transform-types scripts/test-issue201-fenced-recovery.mjs package-acceptance
node scripts/issue201-runtime-package.mjs verify "$package" "$inventory"
node scripts/issue201-runtime-package.mjs verify "$legacy" "$legacy_inventory"
# Prove local Edge's import graph still exactly equals the staged immutable tree.
node --input-type=module - "$package" "$workdir" <<'NODE'
import fs from 'node:fs';import {createHash} from 'node:crypto';
const [p,w]=process.argv.slice(2),inventory=JSON.parse(fs.readFileSync(p+'/RUNTIME_INVENTORY.json'));
for(const f of inventory.files.filter(f=>f.path.startsWith('supabase/functions/'))){
 const b=fs.readFileSync(w+'/'+f.path);
 if(createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('EDGE_STAGED_BYTES_CHANGED');
}
console.log('PACKAGED_LOCAL_EDGE_BYTES=PASS');
NODE
node --input-type=module - "$report" <<'NODE'
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const report=JSON.parse(fs.readFileSync(process.argv[2]));
const changed=execFileSync('git',['diff','--name-only','92a94c49010da880dad234b6c2967e8d305a5009',report.privateSourceSha],{encoding:'utf8'}).trim().split('\n');
if(changed.some(p=>p.startsWith('supabase/migrations/')))throw Error('MIGRATION_CHANGE_PROHIBITED');
const hash=b=>createHash('sha256').update(b).digest('hex');
const paths=changed.map(path=>({path,sha256:hash(execFileSync('git',['cat-file','blob',report.privateSourceSha+':'+path]))}));
const descriptor='services/python-executor-modal/modal_fenced_app.py';
const evidence={...report,changedPathCount:paths.length,changedPaths:paths,privateDescriptorSha256:hash(execFileSync('git',['cat-file','blob',report.privateSourceSha+':'+descriptor])),originalMigrationsUnchanged:95,localDockerOnly:true,realProviderCalls:0,productionActions:0};
fs.writeFileSync(process.env.RUNNER_TEMP+'/packaging-provenance.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({suite:'packaging-exact-source-provenance',privateSourceSha:report.privateSourceSha,inventorySha256:report.inventorySha256,runtimeFiles:report.runtimeFiles,changedPathCount:paths.length,originalMigrationsUnchanged:95,passed:true}));
NODE
