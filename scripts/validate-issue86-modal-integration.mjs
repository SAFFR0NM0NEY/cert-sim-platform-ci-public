import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const serviceRoot = resolve(root, 'services/python-executor-modal');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const packageJson = JSON.parse(read('services/python-executor-modal/package.json'));
const packageLock = JSON.parse(read('services/python-executor-modal/package-lock.json'));

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(resolve(directory, entry.name), relative)
      : [relative];
  });
}

const expectedFiles = [
  'modal_app.py',
  'package-lock.json',
  'package.json',
  'src/config.mjs',
  'src/index.mjs',
  'src/isolation.mjs',
  'src/launcher.py',
  'src/output.mjs',
  'src/provider.mjs',
  'src/server.mjs',
  'src/service.mjs',
  'src/terminal-execution.mjs',
  'src/trusted-grading-flow.mjs',
  'tests/config.test.mjs',
  'tests/output.test.mjs',
  'tests/provider.test.mjs',
  'tests/sdk.test.mjs',
  'tests/terminal-service.test.mjs',
  'tests/trusted-grading-flow.test.mjs',
];
assert.deepEqual(listFiles(serviceRoot).sort(), expectedFiles.sort());
assert.equal(packageJson.private, true);
assert.equal(packageJson.type, 'module');
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.dependencies, { modal: '0.10.1' });
assert.deepEqual(packageJson.devDependencies, {});
assert.equal(packageLock.packages[''].dependencies.modal, '0.10.1');
assert.equal(packageLock.packages['node_modules/modal'].version, '0.10.1');

const runtime = expectedFiles
  .filter((path) => path.startsWith('src/'))
  .map((path) => read(`services/python-executor-modal/${path}`))
  .join('\n');
const edgeRuntime = listFiles(resolve(root, 'supabase/functions'))
  .filter((path) => /\.(?:js|jsx|mjs|ts|tsx|json)$/.test(path))
  .map((path) => read(`supabase/functions/${path}`))
  .join('\n');
const browserRuntime = listFiles(resolve(root, 'src'))
  .filter((path) => /\.(?:js|jsx|mjs|ts|tsx)$/.test(path))
  .map((path) => read(`src/${path}`))
  .join('\n');
const launcher = read('services/python-executor-modal/src/launcher.py');
const provider = read('services/python-executor-modal/src/provider.mjs');
const docs = read('docs/PYTHON_MODAL_INTEGRATION.md');
const modalApp = read('services/python-executor-modal/modal_app.py');
const hotfixLiveProof = read('scripts/test-issue86-modal-stdlib-hotfix-live.mjs');
const workflow = read('.github/workflows/frontend-feature-validation.yml');
const rootPackage = JSON.parse(read('package.json'));

assert.doesNotMatch(edgeRuntime, /from\s+['"]modal['"]|import\(['"]modal['"]\)|python-executor-modal/);
assert.match(runtime, /await import\('modal'\)/);
assert.match(runtime, /CERTSIM_PYTHON_EXECUTION_ENABLED/);
assert.match(runtime, /MODAL_FEATURE_ENABLED_VALUE = 'YES'/);
assert.match(runtime, /new DisabledPythonExecutionProvider\(\)/);
assert.match(runtime, /blockNetwork:\s*true/);
assert.match(runtime, /includeOidcIdentityToken:\s*false/);
assert.match(runtime, /secrets:\s*\[\]/);
assert.match(runtime, /volumes:\s*\{\}/);
assert.match(runtime, /cloudBucketMounts:\s*\{\}/);
assert.match(runtime, /cpuLimit:\s*MODAL_PROVIDER_LIMITS\.cpuLimit/);
assert.match(runtime, /normalizeExecutionRequest/);
assert.match(runtime, /normalizeExecutionResult/);
assert.match(runtime, /verifySignedExecutionEnvelope/);
assert.match(runtime, /createServerExecutionRequest/);
assert.match(runtime, /assertAuthenticatedGradingEvidenceForExecution/);
assert.match(runtime, /createTrustedPythonGradeCallback/);
assert.match(runtime, /executeTrustedPythonGradingRequest/);
assert.match(runtime, /normalizeTrustedGradingMaterial/);
assert.match(runtime, /CERTSIM_PYTHON_GRADING_ENABLED/);
assert.match(runtime, /CERTSIM_GRADING_SIGNING_SECRET/);
assert.match(runtime, /grading === execution/);
assert.match(runtime, /persistVerifiedEvidence/);
assert.match(runtime, /applyGenericScore/);
assert.match(runtime, /executeSignedRequestToTerminal/);
assert.match(runtime, /\/v1\/execute/);
assert.match(runtime, /\/v1\/grade/);
assert.doesNotMatch(runtime, /console\.(?:log|error)|process\.(?:stdout|stderr)\.write/);
assert.doesNotMatch(runtime, /(?:ak|as|oc|ov)-[A-Za-z0-9_-]{16,}/);

assert.match(launcher, /CLONE_NEWUSER \| CLONE_NEWNS \| CLONE_NEWPID/);
assert.match(launcher, /WORKSPACE_BYTES = 16 \* 1024 \* 1024/);
assert.match(launcher, /RLIMIT_NPROC, \(MAX_PROCESSES, MAX_PROCESSES\)/);
assert.match(launcher, /MS_NOSUID \| MS_NODEV \| MS_NOEXEC/);
assert.match(launcher, /os\.setgid\(LEARNER_GID\)[\s\S]+os\.setuid\(LEARNER_UID\)/);
assert.match(launcher, /PR_SET_NO_NEW_PRIVS/);
assert.match(launcher, /PR_SET_SECCOMP/);
assert.match(launcher, /os\.environ\.clear\(\)/);
assert.match(launcher, /os\.chroot\(mountpoint\)/);
const stdlibPreload = launcher.match(/TRUSTED_STDLIB_PRELOAD\s*=\s*\(([\s\S]*?)\)\s*\n/)?.[1] ?? '';
assert.deepEqual(
  [...stdlibPreload.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((match) => match[1]),
  [
    'ast', 'base64', 'builtins', 'contextlib', 'datetime', 'io', 'json', 'math',
    'os', 'pathlib', 'random', 'socket', 'sys', 'tempfile', 'unittest',
  ],
);
assert.match(launcher, /def main\(\):\s*\n\s+preload_trusted_stdlib\(\)/);
assert.match(launcher, /name not in sys\.stdlib_module_names/);
assert.match(launcher, /sys\.path\[:\]\s*=\s*\[entry_directory\][\s\S]+sys\.path\.append\("\/workspace"\)/);
assert.doesNotMatch(launcher, /\bpip\b|site-packages|MS_BIND|--bind|bind_mount/i);
for (const category of [
  'launcher_attestation_failed',
  'launcher_setup_failed',
  'launcher_mapping_failed',
  'provider_wait_rejected',
  'learner_nonzero_exit',
  'timeout',
  'output_limit',
  'completion_exception',
  'disposal_unconfirmed',
]) assert.ok(provider.includes(`'${category}'`), `missing sanitized diagnostic ${category}`);
assert.match(provider, /diagnostics:\s*\[\]/);
assert.doesNotMatch(provider, /logger\([^\n]*(?:stdout|stderr|workspace|request|secret)/);

assert.match(modalApp, /node:22-bookworm-slim/);
assert.match(modalApp, /@modal\.web_server\(8000, startup_timeout=30\.0, requires_proxy_auth=True\)/);
assert.match(modalApp, /min_containers=0/);
assert.match(modalApp, /max_containers=5/);
assert.match(modalApp, /Secret\.from_local_environ/);
const secretDefinition = modalApp.match(/bridge_secrets\s*=\s*modal\.Secret\.from_local_environ\(\s*\[([\s\S]*?)\]\s*\)/)?.[1] ?? '';
assert.deepEqual(
  [...secretDefinition.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
  [
    'CERTSIM_MODAL_API_TOKEN_ID',
    'CERTSIM_MODAL_API_TOKEN_SECRET',
    'CERTSIM_EXECUTION_SIGNING_SECRET',
    'CERTSIM_GRADING_SIGNING_SECRET',
  ],
);
const deploymentEnvironment = modalApp.match(/@app\.function\([\s\S]*?env=\{([\s\S]*?)\},\s*cpu=/)?.[1] ?? '';
assert.deepEqual(
  Object.fromEntries([...deploymentEnvironment.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)]
    .map((match) => [match[1], match[2]])),
  {
    CERTSIM_PYTHON_EXECUTION_ENABLED: 'YES',
    CERTSIM_PYTHON_GRADING_ENABLED: 'YES',
    CERTSIM_MODAL_SAFE_DIAGNOSTICS: 'YES',
    PORT: '8000',
  },
);
assert.match(modalApp, /node_environment\s*=\s*os\.environ\.copy\(\)/);
assert.doesNotMatch(modalApp, /(?:ak|as|wk|ws)-[A-Za-z0-9_-]{8,}/);
assert.doesNotMatch(browserRuntime, /CERTSIM_(?:EXECUTION|GRADING)_SIGNING_SECRET/);
assert.match(docs, /DEVELOPMENT ACCEPTED — PRODUCTION DISABLED/);
assert.match(docs, /Deno 2\.1\.14/);
assert.match(docs, /Node 22\+/);
assert.match(docs, /generic CertSim scorer/);
assert.match(docs, /all 423 rules exactly/);
assert.match(docs, /two corrected TOKEN rules/);
assert.match(docs, /`POST \/v1\/grade`/);
assert.match(docs, /exactly five[\s\S]*6\.729 seconds[\s\S]*billed\/metered delta was zero/);
assert.match(workflow, /services\/python-executor-modal\/\*\*/);
assert.match(workflow, /run: npm run test:issue86-modal-integration/);
assert.equal(
  rootPackage.scripts?.['test:issue86-modal-integration'],
  'npm --prefix services/python-executor-modal ci --ignore-scripts && node scripts/validate-issue86-modal-integration.mjs && npm --prefix services/python-executor-modal test',
);
assert.equal(
  rootPackage.scripts?.['test:issue86-modal-live'],
  'node scripts/test-issue86-modal-live-acceptance.mjs',
);
assert.equal(
  rootPackage.scripts?.['test:issue86-modal-stdlib-live'],
  'node scripts/test-issue86-modal-stdlib-hotfix-live.mjs',
);
assert.match(hotfixLiveProof, /supportedStdlibModules:\s*15/);
assert.match(hotfixLiveProof, /runtimeFamilies:\s*9/);
assert.match(hotfixLiveProof, /sandboxesCreated:\s*3/);
assert.doesNotMatch(hotfixLiveProof, /modelSolution|protectedContent|["']learner(?:Id|Email|Name)["']/i);

console.log(JSON.stringify({
  ok: true,
  issue: 86,
  phase: 'stdlib-runtime-hotfix',
  topology: 'modal-web-server-node22',
  sdk: 'modal@0.10.1',
  featureEnabledByDefault: false,
  deploymentExecutionEnabled: true,
  deploymentGradingEnabled: true,
  learnerSandboxSecrets: 0,
  browserSigningSecrets: 0,
  edgeImports: 1,
  productionDeployments: 0,
}));
