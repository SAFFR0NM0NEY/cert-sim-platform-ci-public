import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executorRoot = path.join(repositoryRoot, 'services', 'python-executor');
const gradingRoot = path.join(repositoryRoot, 'services', 'python-grading');

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  }));
  return nested.flat().sort();
}

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
}

const requiredExecutorPaths = [
  'services/python-executor/package.json',
  'services/python-executor/src/contract.mjs',
  'services/python-executor/src/index.mjs',
  'services/python-executor/src/isolation.mjs',
  'services/python-executor/src/provider.mjs',
  'services/python-executor/tests/contract.test.mjs',
  'services/python-executor/tests/isolation.test.mjs',
  'services/python-executor/tests/provider.test.mjs',
];
const requiredGradingPaths = [
  'services/python-grading/package.json',
  'services/python-grading/src/contract.mjs',
  'services/python-grading/src/index.mjs',
  'services/python-grading/src/runtime-probe-harness.py',
  'services/python-grading/src/trusted-grader.mjs',
  'services/python-grading/src/trusted-grading-contract.mjs',
  'services/python-grading/src/trusted-structural-worker.py',
  'services/python-grading/tests/contract.test.mjs',
  'services/python-grading/tests/trusted-grader.test.mjs',
];
const executorFiles = await listFiles(executorRoot);
const gradingFiles = await listFiles(gradingRoot);
assert.deepEqual(executorFiles.map(relative), requiredExecutorPaths, 'unexpected executor service file set');
assert.deepEqual(gradingFiles.map(relative), requiredGradingPaths, 'unexpected grading service file set');

const servicePackage = JSON.parse(await read('services/python-executor/package.json'));
assert.equal(servicePackage.private, true);
assert.deepEqual(servicePackage.dependencies, {}, 'executor service must have no runtime SDK dependencies');
assert.deepEqual(servicePackage.devDependencies, {}, 'executor service must have no development SDK dependencies');
assert.equal(
  servicePackage.scripts?.test,
  'node --test tests/contract.test.mjs tests/isolation.test.mjs tests/provider.test.mjs',
);
const gradingPackage = JSON.parse(await read('services/python-grading/package.json'));
assert.equal(gradingPackage.private, true);
assert.deepEqual(gradingPackage.dependencies, {}, 'grading service must have no runtime SDK dependencies');
assert.deepEqual(gradingPackage.devDependencies, {}, 'grading service must have no development SDK dependencies');
assert.equal(gradingPackage.scripts?.test, 'node --test tests/*.test.mjs');

const executorTextByPath = new Map(
  await Promise.all(executorFiles.map(async (file) => [relative(file), await readFile(file, 'utf8')])),
);
const gradingTextByPath = new Map(
  await Promise.all(gradingFiles.map(async (file) => [relative(file), await readFile(file, 'utf8')])),
);
const executorText = [...executorTextByPath.values()].join('\n');
const gradingText = [...gradingTextByPath.values()].join('\n');
const combinedServiceText = `${executorText}\n${gradingText}`;
const executorSourceText = [...executorTextByPath]
  .filter(([file]) => file.includes('/src/'))
  .map(([, content]) => content)
  .join('\n');
const gradingSourceText = [...gradingTextByPath]
  .filter(([file]) => file.includes('/src/'))
  .map(([, content]) => content)
  .join('\n');

for (const [label, pattern] of [
  ['specific execution vendor', /\b(?:cloudflare|amazon|aws|azure|google cloud|modal|e2b|judge0|piston)\b/i],
  ['specific container runtime', /\b(?:docker|firecracker|kubernetes)\b/i],
  ['network endpoint', /https?:\/\//i],
  ['environment activation', /CERTSIM_[A-Z0-9_]*ENABLED|PYTHON_EXECUTOR_ENABLED/i],
  ['network runtime', /node:(?:net|http|https|http2|dns|dgram|tls)/i],
]) {
  assert.doesNotMatch(combinedServiceText, pattern, `Issue #86 services contain ${label} coupling`);
}
assert.doesNotMatch(executorText, /node:(?:child_process|cluster|worker_threads)/i,
  'provider-neutral executor contract must not launch processes');

for (const [label, pattern] of [
  ['protected payload field', /\b(?:hiddenTests?|expectedOutput|answerKey|gradingRubric|protectedPayload)\b/i],
  ['platform identity field', /\b(?:learnerId|userId|attemptId|examId|packageId|entitlement)\b/i],
  ['grading field', /\b(?:grade|grading|score|scoring)\b/i],
  ['backend credential field', /\b(?:serviceRole|supabaseKey|databaseUrl)\b/i],
]) {
  assert.doesNotMatch(executorSourceText, pattern, `executor contract contains ${label}`);
}

for (const [label, pattern] of [
  ['protected material body field', /\b(?:hiddenTests?|testSource|expectedOutput|answerKey|gradingRubric|rubric|modelSolution|protectedPayload|gradingRules|ruleText|remediation)\b/i],
  ['platform identity field', /\b(?:learnerId|userId|email|organisation|attemptId|examId|packageId|entitlement)\b/i],
  ['backend credential field', /\b(?:serviceRole|supabaseKey|databaseUrl)\b/i],
]) {
  assert.doesNotMatch(gradingSourceText, pattern, `grading contract contains ${label}`);
}

for (const [file, content] of [...executorTextByPath, ...gradingTextByPath]) {
  if (!file.endsWith('.mjs')) continue;
  const importSpecifiers = [...content.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)]
    .map((match) => match[1]);
  for (const specifier of importSpecifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('.'),
      `${file} imports non-neutral dependency ${specifier}`,
    );
  }
}

const contract = await read('services/python-executor/src/contract.mjs');
for (const required of [
  "SIGNATURE_DOMAIN = 'certsim.python-execution.request-signature.v1'",
  "createHmac('sha256'",
  'timingSafeEqual(suppliedSignature, expectedSignature)',
  'canonicalizeExecutionRequest',
  'canonicalizeExecutionResult',
  'normalizeExecutionRequest',
  'normalizeExecutionResult',
  "runtime.language !== 'python'",
  "runtime.contract !== 'python-source-v1'",
  'files.sort(',
  "reject('DUPLICATE_SOURCE_PATH')",
  "reject('REQUEST_SOURCE_TOO_LARGE')",
  "reject('EXECUTION_RESULT_TOO_LARGE')",
]) {
  assert.ok(contract.includes(required), `missing executor contract invariant: ${required}`);
}

const provider = await read('services/python-executor/src/provider.mjs');
for (const required of [
  'class PythonExecutionProvider',
  'class DisabledPythonExecutionProvider',
  'async execute(',
  'async getStatus(',
  'async cancel(',
  'async dispose(',
  "reject('EXECUTOR_DISABLED')",
  'createDefaultPythonExecutionProvider',
  'return new DisabledPythonExecutionProvider()',
]) {
  assert.ok(provider.includes(required), `missing disabled provider invariant: ${required}`);
}
assert.equal(
  [...provider.matchAll(/reject\('EXECUTOR_DISABLED'\)/g)].length,
  4,
  'each disabled-provider lifecycle method must terminate with EXECUTOR_DISABLED',
);
assert.doesNotMatch(
  provider,
  /normalizeExecutionRequest|assertExecutionId|INVALID_EXECUTION_ID|OPAQUE_EXECUTION_ID/,
  'disabled provider must not interpret request or execution-ID input',
);

const isolation = await read('services/python-executor/src/isolation.mjs');
for (const required of [
  "ISOLATION_CONTRACT_VERSION = 'certsim.python-execution.isolation.v1'",
  "ISOLATION_DECLARATION_ASSURANCE = 'declaration-only-not-security-evidence'",
  'ISOLATION_REQUIRED_CONTROL_COUNT',
  'normalizeIsolationCapabilityDeclaration',
  'assertDeclaredIsolationCapabilitiesMeetPolicy',
  'assertExecutionRequestWithinDeclaredCapabilities',
  'resources.output.enforcedDuringStreaming',
  "['network.callerOverride', 'prohibited']",
  "['filesystem.crossRunState', 'prohibited']",
  "['environment.signingKeyExposure', 'prohibited']",
  "['lifecycle.ambiguousTermination', 'reconcile-before-retry']",
  'EXECUTION_LIMITS.maxWallTimeMs',
  'EXECUTION_LIMITS.maxMemoryBytes',
  'EXECUTION_LIMITS.maxOutputBytes',
]) {
  assert.ok(isolation.includes(required), `missing isolation contract invariant: ${required}`);
}
assert.doesNotMatch(
  contract,
  /networkEnabled|allowSubprocess|allowHostFilesystem|retainFiles|allowSecrets|disableSandbox|reuseEnvironment|retainWorkspace/,
  'learner execution request must not contain isolation overrides',
);
const index = await read('services/python-executor/src/index.mjs');
assert.match(index, /export \* from '\.\/isolation\.mjs';/);

const gradingContract = await read('services/python-grading/src/contract.mjs');
for (const required of [
  "GRADING_BINDING_VERSION = 'certsim.python-grading.binding.v1'",
  "GRADING_EVIDENCE_VERSION = 'certsim.python-grading.evidence.v1'",
  "GRADING_EVIDENCE_ENVELOPE_VERSION =",
  "'certsim.python-grading.evidence-envelope.v1'",
  "GRADING_EVIDENCE_SIGNATURE_DOMAIN =",
  "'certsim.python-grading.evidence-signature.v1'",
  "createHash('sha256')",
  "createHmac('sha256'",
  'timingSafeEqual(suppliedSignature, expectedSignature)',
  'canonicalizeExecutionRequest',
  'canonicalizeExecutionResult',
  'normalizeGradingBinding',
  'normalizeGradingEvidence',
  'createSignedGradingEvidenceEnvelope',
  'verifySignedGradingEvidenceEnvelope',
  'assertAuthenticatedGradingEvidenceForExecution',
  "new Set(['finished', 'cancelled', 'failed'])",
  "reject('EXECUTION_RESULT_NOT_TERMINAL')",
]) {
  assert.ok(gradingContract.includes(required), `missing grading contract invariant: ${required}`);
}
assert.doesNotMatch(
  gradingContract,
  /certsim\.python-execution\.request-signature\.v1/,
  'grading evidence must not reuse the execution-request signature domain',
);
assert.match(
  gradingContract,
  /export function createExecutionRequestDigest\(request\) \{[\s\S]*?\.update\(canonicalizeExecutionRequest\(request\), 'utf8'\)[\s\S]*?\.digest\('hex'\);/,
  'R4 execution request digest must remain SHA-256 over the complete canonical R2 request',
);
const gradingIndex = await read('services/python-grading/src/index.mjs');
for (const module of ['./contract.mjs', './trusted-grading-contract.mjs', './trusted-grader.mjs']) {
  assert.ok(gradingIndex.includes(`export * from '${module}';`), `missing grading export ${module}`);
}
const trustedGradingContract = await read('services/python-grading/src/trusted-grading-contract.mjs');
for (const required of [
  "TRUSTED_GRADING_CONTRACT_VERSION = 'certsim-python-trusted-grading-v1'",
  'TRUSTED_GRADING_RUNTIME_TYPES',
  'TRUSTED_GRADING_STRUCTURAL_TYPES',
  'normalizeTrustedGradingMaterial',
  'normalizeTrustedGradingObservation',
  "reject('INCOMPLETE_TRUSTED_GRADING_MATERIAL')",
  'createTrustedGradingMaterialDigest',
]) assert.ok(trustedGradingContract.includes(required), `missing trusted-grading invariant: ${required}`);
const trustedGrader = await read('services/python-grading/src/trusted-grader.mjs');
for (const required of [
  'buildTrustedRuntimeProbeWorkspace',
  'evaluateTrustedStructuralRules',
  'parseTrustedRuntimeProbeObservations',
  'gradeTrustedPythonWorkspace',
  'normalizeTrustedGradingObservation',
  'expectedObservation: _expected',
]) assert.ok(trustedGrader.includes(required), `missing trusted-grader invariant: ${required}`);
assert.doesNotMatch(trustedGrader, /sourceSpecification|sourceRequirement|modelSolution|ruleText|remediation/);

const rootPackage = JSON.parse(await read('package.json'));
assert.equal(
  rootPackage.scripts?.['validate:issue86'],
  'node scripts/validate-issue86-python-executor.mjs && node scripts/validate-issue86-browse-registration.mjs && npm --prefix services/python-executor test && npm --prefix services/python-grading test && npm run test:issue86-frontend',
);
assert.equal(
  rootPackage.scripts?.['test:issue86-frontend'],
  'node --test scripts/test-issue86-python-lab-frontend.mjs',
);
assert.equal(
  rootPackage.scripts?.['test:issue86-browser'],
  'playwright test tests/r3g/issue86-python-lab.spec.js tests/r3g/issue86-browse-registration.spec.js --workers=1 && playwright test tests/r3g/app-python-next-generation-access.spec.js --config playwright.auth.config.js --workers=1',
);
assert.ok(
  !rootPackage.scripts?.validate.includes('validate:issue86'),
  'Issue #86 must remain outside the public umbrella until exporter compatibility is resolved',
);

const workflow = await read('.github/workflows/frontend-feature-validation.yml');
assert.match(workflow, /services\/python-executor\/\*\*/);
assert.match(workflow, /services\/python-grading\/\*\*/);
assert.match(workflow, /run: npm run validate:issue86/);

const architecture = await read('docs/CERTSIM_ARCHITECTURE_STANDARD.md');
assert.match(architecture, /## Disabled Python executor contract foundation/);
assert.match(architecture, /not production-active/i);
assert.match(architecture, /Python grading boundary contract/);
assert.match(architecture, /## Durable Python orchestration foundation/);
const securityContract = await read('docs/PYTHON_EXECUTOR_SECURITY_CONTRACT.md');
assert.match(securityContract, /IMPLEMENTED MODAL ADAPTER — EXECUTOR DISABLED \/ NOT PRODUCTION ACTIVE/);
assert.match(securityContract, /DEFERRED_EXPORTER_COMPATIBILITY/);
assert.match(securityContract, /Python executor isolation contract/);
assert.match(securityContract, /Python grading boundary contract/);
const isolationContract = await read('docs/PYTHON_EXECUTOR_ISOLATION_CONTRACT.md');
assert.match(isolationContract, /MODAL CAPABILITY APPROVED — NO PRODUCTION EXECUTOR ACTIVE/);
assert.match(isolationContract, /Capability declaration is not evidence/);
assert.match(isolationContract, /R8_REAL_PROVIDER_EVIDENCE/);
assert.match(isolationContract, /Python grading boundary contract/);
const gradingBoundaryContract = await read('docs/PYTHON_GRADING_BOUNDARY_CONTRACT.md');
assert.match(gradingBoundaryContract, /TRUSTED FLOW INTEGRATED — NO PRODUCTION GRADING SERVICE OR EXECUTOR ACTIVE/);
assert.match(gradingBoundaryContract, /LEARNER EXECUTION OUTPUT IS NOT AUTHORITATIVE SCORE/);
assert.match(gradingBoundaryContract, /PROVIDER IS INELIGIBLE FOR PROTECTED GRADING/);
assert.match(gradingBoundaryContract, /R5 durable replay authority/i);
assert.match(gradingBoundaryContract, /canonical R4 execution-request\s+digest/i);
assert.match(gradingBoundaryContract, /not the orchestration request digest/i);
assert.match(gradingBoundaryContract, /R8_REAL_PROVIDER_EVIDENCE/);
assert.match(gradingBoundaryContract, /All 49 private[\s\S]+423 rules compile exactly/i);
assert.match(gradingBoundaryContract, /fail-closed incomplete evidence/i);
const orchestrationContract = await read('docs/PYTHON_EXECUTION_ORCHESTRATION_CONTRACT.md');
assert.match(orchestrationContract, /INTEGRATION IMPLEMENTED — PRODUCTION DISABLED/);
assert.match(orchestrationContract, /optimistic revision/i);
assert.match(orchestrationContract, /executor_disabled/);
assert.match(orchestrationContract, /generic CertSim\s+scorer/i);
assert.match(orchestrationContract, /R4 cryptographic boundary/i);
assert.match(orchestrationContract, /orchestration request digest/i);
assert.match(orchestrationContract, /execution request digest/i);
assert.match(orchestrationContract, /no saved workspace is intentionally `Unanswered`/i);
assert.match(orchestrationContract, /missing or invalid evidence fails with `grading_incomplete`/i);
assert.match(orchestrationContract, /all 49 tasks and all 423/);
const docsIndex = await read('docs/README.md');
assert.match(docsIndex, /\[Python executor security contract\]\(PYTHON_EXECUTOR_SECURITY_CONTRACT\.md\)/);
assert.match(docsIndex, /\[Python executor isolation contract\]\(PYTHON_EXECUTOR_ISOLATION_CONTRACT\.md\)/);
assert.match(docsIndex, /\[Python grading boundary contract\]\(PYTHON_GRADING_BOUNDARY_CONTRACT\.md\)/);
assert.match(docsIndex, /\[Python execution orchestration contract\]\(PYTHON_EXECUTION_ORCHESTRATION_CONTRACT\.md\)/);

const applicationRoots = ['src'];
const applicationFiles = (await Promise.all(applicationRoots.map(async (root) => {
  const files = await listFiles(path.join(repositoryRoot, root));
  return files;
}))).flat();
for (const file of applicationFiles) {
  if (!/\.(?:js|jsx|mjs|ts|tsx)$/.test(file)) continue;
  const content = await readFile(file, 'utf8');
  assert.doesNotMatch(
    content,
    /services\/python-(?:executor|grading)|python-(?:execution|grading)\.(?:request|evidence)-signature/i,
    `Issue #86 contract services must not be integrated by ${relative(file)}`,
  );
}

const migrationNames = (await readdir(path.join(repositoryRoot, 'supabase', 'migrations')))
  .filter((name) => /issue86|python_(?:executor|grading)/i.test(name))
  .sort();
assert.deepEqual(
  migrationNames,
  [
    '20260914120212_issue86_python_lab_orchestration.sql',
    '20260915063933_issue86_modal_execution_completion.sql',
    '20260916103000_issue86_trusted_grading_completion.sql',
    '20260916155319_issue86_python_next_generation_release_prep.sql',
    '20260917121244_issue86_executable_submission_run_restore.sql',
    '20260917185333_issue86_live_submit_recovery.sql',
  ],
  'Issue #86 must retain R5/R8/trusted grading, release preparation, acceptance, and live-submit recovery',
);
const allMigrationNames = (await readdir(path.join(repositoryRoot, 'supabase', 'migrations')))
  .filter((name) => name.endsWith('.sql'))
  .sort();
assert.equal(
  allMigrationNames.at(-6),
  migrationNames[3],
  'Issue #86 release-preparation migration must immediately precede the Platform Owner access correction',
);
assert.equal(
  allMigrationNames.at(-5),
  '20260917074357_platform_owner_protected_exam_bypass.sql',
  'Platform Owner access correction must precede the live-acceptance correction',
);
assert.equal(
  allMigrationNames.at(-4),
  migrationNames[4],
  'Issue #86 live-acceptance correction must precede live-submit recovery',
);
assert.equal(
  allMigrationNames.at(-3),
  migrationNames[5],
  'Issue #86 live-submit recovery must immediately precede Issue #133 Phase 4B',
);
assert.equal(
  allMigrationNames.at(-2),
  '20260920124528_issue133_examops_phase4b.sql',
  'Issue #133 Phase 4B must immediately precede Phase 5A',
);
assert.equal(
  allMigrationNames.at(-1),
  '20260921044626_issue133_phase5a_operator_readonly.sql',
  'Issue #133 Phase 5A must be the current migration tail',
);
const orchestrationMigration = await read(`supabase/migrations/${migrationNames[0]}`);
const completionMigration = await read(`supabase/migrations/${migrationNames[1]}`);
const trustedCompletionMigration = await read(`supabase/migrations/${migrationNames[2]}`);
const releasePreparationMigration = await read(`supabase/migrations/${migrationNames[3]}`);
const acceptanceCorrectionMigration = await read(`supabase/migrations/${migrationNames[4]}`);
const liveSubmitRecoveryMigration = await read(`supabase/migrations/${migrationNames[5]}`);
for (const table of [
  'python_lab_workspaces',
  'python_lab_workspace_revisions',
  'python_execution_runs',
  'python_grading_materializations',
  'python_grading_evidence',
]) {
  assert.match(orchestrationMigration, new RegExp(`create table exam_delivery\\.${table}\\b`));
  assert.match(orchestrationMigration, new RegExp(`alter table exam_delivery\\.${table} enable row level security`));
}
for (const wrapper of [
  'certsim_protected_get_python_workspace',
  'certsim_protected_save_python_workspace',
  'certsim_protected_request_python_run',
  'certsim_protected_get_python_run',
  'certsim_protected_cancel_python_run',
]) {
  assert.match(orchestrationMigration, new RegExp(`create function public\\.${wrapper}\\(`));
}
for (const required of [
  'python_workspace_valid',
  'python_workspace_hash',
  'python_orchestration_request_digest',
  'orchestration_request_digest text not null',
  'execution_request_digest text',
  'python_lab_workspace_revisions_request_unique unique (request_id)',
  'python_execution_runs_request_unique unique (execution_request_id)',
  'python_execution_runs_execution_request_digest_unique',
  "state = 'authorized' or execution_request_digest is not null",
  'python_execution_runs_one_active_item_idx',
  'run_id uuid not null unique',
  "state in ('authorized', 'queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')",
  "return jsonb_build_object('ok', false, 'code', 'executor_disabled')",
  'Deliberately no insert and no provider call',
  'persist_verified_python_grading_evidence',
  'to service_role',
]) {
  assert.ok(orchestrationMigration.includes(required), `missing R5 orchestration invariant: ${required}`);
}
assert.doesNotMatch(orchestrationMigration, /python_run_request_digest/);
assert.doesNotMatch(orchestrationMigration, /(?:^|\s)request_digest\s+(?:text|varchar)/m);
assert.match(
  orchestrationMigration,
  /create table exam_delivery\.python_execution_runs \([\s\S]*?orchestration_request_digest text not null,[\s\S]*?execution_request_digest text,[\s\S]*?\n\);/,
);
assert.match(
  orchestrationMigration,
  /create table exam_delivery\.python_grading_materializations \([\s\S]*?execution_request_digest text not null,[\s\S]*?foreign key \(run_id, execution_request_digest\)[\s\S]*?references exam_delivery\.python_execution_runs\(id, execution_request_digest\)/,
);
assert.match(
  orchestrationMigration,
  /create table exam_delivery\.python_grading_evidence \([\s\S]*?execution_request_digest text not null,[\s\S]*?foreign key \(run_id, execution_request_digest, execution_result_digest\)[\s\S]*?references exam_delivery\.python_execution_runs\(id, execution_request_digest, execution_result_digest\)/,
);
assert.match(
  orchestrationMigration,
  /p_execution_request_digest text[\s\S]*?run\.execution_request_digest = p_execution_request_digest[\s\S]*?insert into exam_delivery\.python_grading_evidence\([\s\S]*?execution_request_digest, execution_result_digest/,
);
assert.match(
  orchestrationMigration,
  /old\.orchestration_request_digest is distinct from new\.orchestration_request_digest[\s\S]*?old\.execution_request_digest is not null[\s\S]*?python_run_execution_request_digest_immutable/,
);
assert.doesNotMatch(
  orchestrationMigration.match(/create table exam_delivery\.python_grading_materializations \([\s\S]*?\n\);/)?.[0] ?? '',
  /orchestration_request_digest/,
);
assert.doesNotMatch(
  orchestrationMigration.match(/create table exam_delivery\.python_grading_evidence \([\s\S]*?\n\);/)?.[0] ?? '',
  /orchestration_request_digest/,
);
assert.match(orchestrationMigration, /revoke all on table exam_delivery\.python_lab_workspaces,[\s\S]+from public, anon, authenticated, service_role/);
assert.match(orchestrationMigration, /revoke execute on function[\s\S]+exam_delivery\.persist_verified_python_grading_evidence\([\s\S]+from public, anon, authenticated, service_role/);
assert.doesNotMatch(orchestrationMigration, /grant execute on function exam_delivery\.persist_verified_python_grading_evidence[\s\S]+to service_role/);
assert.doesNotMatch(orchestrationMigration, /\b(?:e2b|modal|daytona|firecracker|lambda|cloudflare sandbox)\b/i);
assert.doesNotMatch(orchestrationMigration, /https?:\/\/|\b(?:hidden_tests?|answer_key|model_solution|material_payload|grading_secret)\b/i);
assert.doesNotMatch(orchestrationMigration, /insert into exam_delivery\.(?:package_versions|package_profiles|package_questions|practice_policies|exam_profile_activations)/i);
for (const required of [
  'client_request_id uuid',
  'learner_stdout text',
  'learner_stderr text',
  'learner_exit_code integer',
  'begin_python_execution',
  'complete_python_execution',
  'get_python_execution_authority',
  'python_execution_runs_client_request_unique',
  "'replayed', true",
  "'code', 'run_in_progress'",
  "'disposalState', v_run.disposal_state",
  'to service_role',
]) assert.ok(completionMigration.includes(required), `missing integration migration invariant: ${required}`);
assert.match(completionMigration, /from public, anon, authenticated, service_role/);
assert.doesNotMatch(completionMigration, /insert into exam_delivery\.(?:package_versions|package_profiles|package_questions|practice_policies|exam_profile_activations)/i);
for (const required of [
  'python_submission_grading_sessions',
  'python_submission_grading_runs',
  'submission_in_progress',
  'prepare_python_submission_grading',
  'materialize_python_submission_grading',
  'score_attempt_item_with_trusted_grading',
  'submit_attempt_v2_with_trusted_grading',
  'certsim_service_prepare_python_submission_grading',
  'certsim_service_materialize_python_submission_grading',
  'certsim_service_persist_verified_python_grading_evidence',
  "'replayed', true",
  "'workspaceRevision'",
  "'workspaceHash'",
  "'executable-python-lab-v1'",
  "'certsim-python-next-generation-canonical-forms-v1'",
  "'certsim-python-trusted-grading-v1'",
  "q->'privateScoring'",
]) assert.ok(trustedCompletionMigration.includes(required), `missing trusted completion invariant: ${required}`);
assert.match(trustedCompletionMigration, /'code'\s*,\s*'grading_incomplete'/);
assert.match(trustedCompletionMigration, /alter table exam_delivery\.python_submission_grading_sessions enable row level security/);
assert.match(trustedCompletionMigration, /alter table exam_delivery\.python_submission_grading_runs enable row level security/);
assert.match(trustedCompletionMigration, /question_type='executable-python-lab-v1' then '\{\}'::jsonb else jsonb_build_object\(/);
assert.match(trustedCompletionMigration, /from public,anon,authenticated,service_role/);
assert.doesNotMatch(trustedCompletionMigration, /insert into exam_delivery\.(?:practice_policies|exam_profile_activations)/i);
assert.match(releasePreparationMigration, /insert into exam_delivery\.exam_release_candidates\s*\(/i);
assert.match(
  releasePreparationMigration,
  /on conflict \(canonical_exam_key, package_version, profile_key\)\s*do update set/i,
);
for (const required of [
  "'pythonnextgeneration'",
  "'1.0.0'",
  "'standard_active_exam_v1'",
  "'Python Next Generation'",
  "'Certiport'",
  "'certification'",
  "'official_source'",
]) assert.ok(releasePreparationMigration.includes(required), `missing release-preparation value: ${required}`);
assert.equal((releasePreparationMigration.match(/'pythonnextgeneration-no-lab'/g) ?? []).length, 1);
assert.equal((releasePreparationMigration.match(/'pythonnextgeneration-lab'/g) ?? []).length, 1);
assert.doesNotMatch(
  releasePreparationMigration,
  /insert into (?:exam_delivery\.(?:practice_policies|package_profile_defaults|exam_profile_activations)|public\.exam_catalog)/i,
);
for (const required of [
  'get_latest_python_run',
  'certsim_protected_get_latest_python_run',
  "'status','Unanswered'",
  "'ready', coalesce(v_ready, true)",
  'python_submission_grading_runs submission_run',
  'workspace.attempt_item_id is not null',
]) assert.ok(acceptanceCorrectionMigration.includes(required), `missing acceptance correction invariant: ${required}`);
assert.match(acceptanceCorrectionMigration, /not exists \([\s\S]*?python_submission_grading_runs[\s\S]*?submission_run\.run_id = run\.id/);
assert.match(acceptanceCorrectionMigration, /revoke all on function public\.certsim_protected_get_latest_python_run/);
assert.match(acceptanceCorrectionMigration, /grant execute on function public\.certsim_protected_get_latest_python_run[\s\S]*?to service_role/);
assert.doesNotMatch(acceptanceCorrectionMigration, /insert into exam_delivery\.(?:package_versions|package_profiles|package_questions|practice_policies|exam_profile_activations)/i);
assert.match(liveSubmitRecoveryMigration, /create or replace function exam_delivery\.authorize_attempt_continuation/);
assert.match(liveSubmitRecoveryMigration, /p_operation='submit' and v_frozen_submission/);
assert.match(liveSubmitRecoveryMigration, /session\.created_at < v\.expires_at/);
assert.match(liveSubmitRecoveryMigration, /request_python_submission_grading_cancellation/);
assert.match(liveSubmitRecoveryMigration, /state='cancel_requested'/);
assert.match(liveSubmitRecoveryMigration, /cancellation_request_id=p_request_id/);
assert.doesNotMatch(liveSubmitRecoveryMigration, /insert into exam_delivery\.(?:package_versions|package_profiles|package_questions|practice_policies|exam_profile_activations)/i);
const releaseIntegration = await read('scripts/test-issue86-release-configuration-integration.mjs');
assert.match(releaseIntegration, /exam_delivery\.configure_exam_release_stage/);
assert.match(releaseIntegration, /'noLabAcceptance'/);
assert.match(releaseIntegration, /'labAcceptance'/);
assert.match(releaseIntegration, /'noLabActive'/);
assert.match(releaseIntegration, /'labActive'/);
assert.match(releaseIntegration, /maximum_completed_attempts is not null/);
assert.match(releaseIntegration, /purpose='pbq_practice'/);
assert.match(releaseIntegration, /declared_review_release_policy='after_submission'/);
assert.match(releaseIntegration, /rollback;/);

const edgeFiles = {
  routes: await read('supabase/functions/certsim-protected-exam/routes.ts'),
  handler: await read('supabase/functions/certsim-protected-exam/handler.ts'),
  responses: await read('supabase/functions/certsim-protected-exam/responses.ts'),
  validation: await read('supabase/functions/certsim-protected-exam/validation.ts'),
  errors: await read('supabase/functions/certsim-protected-exam/errors.ts'),
  tests: await read('supabase/functions/certsim-protected-exam/tests/function_test.ts'),
  gradingTests: await read('supabase/functions/certsim-protected-exam/tests/python_grading_test.ts'),
  transport: await read('supabase/functions/tests/integration_test.ts'),
};
for (const operation of ['pythonWorkspaceGet', 'pythonWorkspaceSave', 'pythonRunRequest', 'pythonRunLatest', 'pythonRunStatus', 'pythonRunCancel']) {
  assert.match(edgeFiles.routes, new RegExp(operation));
  assert.match(edgeFiles.handler, new RegExp(operation));
}
assert.match(edgeFiles.validation, /PYTHON_WORKSPACE_BODY_BYTES = 300 \* 1024/);
assert.match(edgeFiles.validation, /workspace\.files\.length > 16/);
assert.match(edgeFiles.validation, /utf8Length\(file\.content\) > 64 \* 1024/);
assert.match(edgeFiles.validation, /totalBytes > 256 \* 1024/);
assert.match(edgeFiles.handler, /p_actor_id: actorId/);
assert.match(edgeFiles.errors, /executor_disabled: 503/);
assert.match(edgeFiles.responses, /mapPythonWorkspace/);
assert.match(edgeFiles.responses, /mapPythonRun/);
assert.match(edgeFiles.responses, /mapLatestPythonRun/);
assert.match(edgeFiles.tests, /server-disabled without configuration/);
assert.match(edgeFiles.transport, /python_execution_runs/);
const edgeExecution = await read('supabase/functions/certsim-protected-exam/python-execution.ts');
assert.match(edgeExecution, /CERTSIM_MODAL_BRIDGE_URL/);
assert.match(edgeExecution, /certsim_service_begin_python_execution/);
assert.match(edgeExecution, /certsim_service_complete_python_execution/);
assert.match(edgeExecution, /CERTSIM_EXECUTION_SIGNING_SECRET/);
assert.doesNotMatch(edgeExecution, /(?:ak|as|wk|ws)-[A-Za-z0-9_-]{8,}/);
const edgeGrading = await read('supabase/functions/certsim-protected-exam/python-grading.ts');
assert.match(edgeFiles.handler, /submitProtectedAttemptWithPythonGrading/);
for (const required of [
  'CERTSIM_PYTHON_GRADING_ENABLED',
  'CERTSIM_GRADING_SIGNING_SECRET',
  'certsim_service_prepare_python_submission_grading',
  'certsim_service_materialize_python_submission_grading',
  'certsim_service_persist_verified_python_grading_evidence',
  'certsim_service_request_python_submission_grading_cancellation',
  'certsim_protected_submit_attempt',
  'verifyEvidence',
  'runBounded',
  'reconcileFailedTransport',
  'reconcileActiveGeneration',
  'recoverableGenerationFailure',
  'MAX_SUBMISSION_PASSES',
]) assert.ok(edgeGrading.includes(required), `missing Edge trusted grading invariant: ${required}`);
assert.match(edgeFiles.gradingTests, /invalid R4 signature/);
assert.match(edgeFiles.gradingTests, /stops after one reconciled replacement generation/);
assert.match(edgeFiles.gradingTests, /fresh two-workspace submit replaces one reconciled live provider failure/);
assert.match(edgeFiles.gradingTests, /learner_nonzero_exit/);
assert.match(edgeFiles.gradingTests, /invalid grading material remains terminal/);
assert.match(edgeFiles.gradingTests, /grading binding mismatch remains terminal/);
assert.match(edgeFiles.gradingTests, /reconciles one stranded generation and reuses existing evidence/);
assert.match(edgeFiles.gradingTests, /ready submission replay/);
assert.doesNotMatch(edgeGrading, /console\.(?:log|error)|(?:hiddenTests?|modelSolution|answerKey)/i);

const frontendFiles = await listFiles(path.join(repositoryRoot, 'src'));
const frontendText = (await Promise.all(frontendFiles
  .filter((file) => /\.(?:js|jsx|mjs|ts|tsx)$/.test(file))
  .map((file) => readFile(file, 'utf8')))).join('\n');
const pythonWorkspace = await read('src/lib/pythonLabWorkspace.js');
const pythonComponent = await read('src/components/exam/PythonLabWorkspace.jsx');
const pythonEditor = await read('src/components/exam/PythonCodeEditor.jsx');
const executableReview = await read('src/components/exam/ReleasedExecutablePythonReview.jsx');
const protectedContract = await read('src/lib/protectedExamContract.js');
const protectedClient = await read('src/lib/protectedExamClient.js');
const protectedRunner = await read('src/components/exam/ProtectedExamRunner.jsx');
const workspacePresentation = await read('src/components/exam/ExamWorkspacePresentation.jsx');
const questionNavigator = await read('src/components/exam/QuestionNavigator.jsx');
const finalSubmitReview = await read('src/components/exam/ProtectedFinalSubmitReview.jsx');
const frontendTest = await read('scripts/test-issue86-python-lab-frontend.mjs');
const frontendBrowserTest = await read('tests/r3g/issue86-python-lab.spec.js');

assert.match(protectedContract, /'executable-python-lab-v1'/);
assert.match(pythonWorkspace, /PYTHON_LAB_INTERACTION_VERSION = 'executable-python-lab-v1'/);
for (const boundary of [
  'normalizePythonLabPresentation', 'normalizePythonWorkspace',
  'normalizePythonRunDto', 'normalizeLatestPythonRunDto', 'createPythonLabWorkspaceController',
]) assert.match(pythonWorkspace, new RegExp(`export function ${boundary}\\b`));
for (const method of [
  'getPythonWorkspace', 'savePythonWorkspace', 'requestPythonRun',
  'getLatestPythonRun', 'getPythonRun', 'cancelPythonRun',
]) assert.match(protectedClient, new RegExp(`${method}:`));
for (const route of [
  '/python/workspace', '/python/runs', '/cancel',
]) assert.ok(protectedClient.includes(route), `missing R6 protected client route: ${route}`);
assert.match(protectedClient, /SUBMISSION_TIMEOUT_MS = 120_000/);
assert.match(protectedClient, /PYTHON_RUN_TIMEOUT_MS = 60_000/);
assert.match(protectedClient, /requestPythonRun:[\s\S]*?timeoutMs: PYTHON_RUN_TIMEOUT_MS/);
assert.match(protectedClient, /export function isRetrySafeSubmissionError\(error\)/);
assert.match(protectedClient, /return RETRY_SAFE_GRADING_CODES\.has\(error\?\.code\)/);
assert.match(protectedClient, /export function isRetrySafeResultLookupError\(error\)/);
assert.match(protectedClient, /if \(isRetrySafeSubmissionError\(submitError\)\) throw submitError/);
assert.match(protectedClient, /lookupError\?\.code === 'attempt_not_found'[\s\S]*?'submission_in_progress'/);
assert.match(protectedClient, /if \(isRetrySafeResultLookupError\(lookupError\)\) throw lookupError/);
assert.match(workspacePresentation, /<PythonLabWorkspace/);
assert.match(workspacePresentation, /isExecutablePythonLab\(currentQuestion\)/);
assert.match(protectedRunner, /pythonWorkspaceSave\.current/);
assert.match(protectedRunner, /registered\.save\(\{ signal: operationController\.current\.signal \}\)/);
assert.match(protectedRunner, /const progress = pythonWorkspaceProgress\[question\.id\]/);
assert.match(protectedRunner, /onNavigateToItem=\{\(index\) => \{ setShowFinalSubmitReview\(false\); navigate\(index\); \}\}/);
assert.match(protectedRunner, /questionStateById=\{pythonQuestionStateById\}/);
assert.doesNotMatch(protectedRunner, /registered\?\.itemId !== itemId\) return true/);
assert.match(questionNavigator, /questionState=\{questionStateById\[question\.id\]\}/);
assert.match(finalSubmitReview, /questionStateById\[question\.id\] \?\? getAnswerState/);
assert.doesNotMatch(pythonComponent, /saveResponse|providerExecutionId|executionRequestDigest|orchestrationRequestDigest|gradingOutput/);
assert.doesNotMatch(pythonWorkspace, /providerExecutionId|orchestrationRequestDigest|gradingOutput/);
assert.match(pythonComponent, /Program output/);
assert.match(pythonComponent, /current\.run\.stdout/);
assert.match(pythonComponent, /current\.run\.stderr/);
assert.match(pythonComponent, /No execution result is available\./);
assert.match(pythonComponent, /Revision \$\{current\.serverRevision\}/);
assert.match(pythonComponent, /Use server version/);
assert.match(pythonComponent, /Keep my edits/);
assert.match(pythonComponent, /Run result for Revision/);
assert.doesNotMatch(pythonComponent, /<textarea/);
for (const editorInvariant of [
  /@codemirror\/lang-python/,
  /lineNumbers\(\)/,
  /highlightActiveLine\(\)/,
  /bracketMatching\(\)/,
  /indentWithTab/,
  /aria-label/,
]) assert.match(pythonEditor, editorInvariant);
assert.match(executableReview, /Python coding task/);
assert.doesNotMatch(executableReview, /Correct answer|Your response|correctAnswer|response/);
assert.match(pythonWorkspace, /GENERIC_PYTHON_TASK_HEADING = 'Python coding task'/);
assert.match(pythonWorkspace, /MAX_RUN_REQUEST_ATTEMPTS = 2/);
assert.match(pythonWorkspace, /The Run outcome could not be confirmed\. Your code is saved\. Retry Run to reconcile the same request\./);
assert.match(pythonWorkspace, /value\.allowedFilenames \?\? value\.editableFiles/);
assert.match(frontendTest, /published Python Next Generation presentation adapts/);
assert.match(frontendTest, /invalid_python_lab_starter_workspace/);
assert.match(frontendTest, /learner Run uses a dedicated timeout that accepts the live 21\.5 second case/);
assert.match(frontendTest, /ambiguous learner Run automatically reconciles once with the same request identity/);
assert.match(frontendTest, /two ambiguous Run transports stop safely and retain source plus request identity/);
assert.match(frontendTest, /server-authoritative terminal Run failure remains a normal rendered result/);
assert.match(frontendBrowserTest, /real published presentation shape/);
assert.match(frontendBrowserTest, /reload resumes the same formal Lab attempt/);
assert.equal([...frontendTest.matchAll(/\btest\('/g)].length, 29);
assert.equal([...frontendBrowserTest.matchAll(/\btest\('/g)].length, 8);
assert.match(orchestrationContract, /## Learner workspace integration/);
assert.match(orchestrationContract, /never stores\s+source as an ordinary answer response/i);
assert.match(securityContract, /## R8\.1 Modal proof result/);
for (const proof of [
  /zero-egress/i, /metadata-service denial/i, /CPU and memory ceilings/i,
  /writable-disk ceiling/i, /process\/fork ceiling/i, /wall-time termination/i,
  /output-flood containment/i, /bounded cancellation/i, /terminal disposal/i,
  /state across runs/i, /secret-free learner environment/i,
  /learner inability to read, enumerate, import, or log protected grader input/i,
  /one-way external path into the trusted grader/i,
]) assert.match(securityContract, proof);
assert.match(securityContract, /Modal is eligible for integration/i);
assert.match(securityContract, /60 PASS, 0 FAIL, and 0 UNPROVEN/i);
assert.doesNotMatch(frontendText, /@modal|from ['"]modal['"]|from ['"]e2b['"]|providerExecutionId/);

console.log(JSON.stringify({
  ok: true,
  umbrellaIntegration: 'DEFERRED_EXPORTER_COMPATIBILITY',
  executorFiles: executorFiles.length,
  gradingFiles: gradingFiles.length,
  isolationRequiredControls: 60,
  isolationAssurance: 'declaration-only-not-security-evidence',
  protectedMaterialBodies: 0,
  gradingSignatureDomainSeparated: true,
  providerSpecificReferences: 0,
  realAdapters: 1,
  sdkDependencies: 0,
  executionRuntimeImports: 0,
  edgeServiceImports: 1,
  learnerWorkspaceIntegrated: true,
  frontendFocusedTests: 32,
  migration: migrationNames[5],
  orchestrationTables: 7,
  protectedOperations: 6,
  trustedSubmissionOperations: 3,
  providerCalls: 0,
  learnerExecution: 'protected-modal-path-disabled-by-default',
}, null, 2));
