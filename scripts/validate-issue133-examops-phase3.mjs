import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import {
  MIGRATION_CLASSIFICATIONS,
  validateExamOperationsCandidate,
} from './backend-exam-publication/exam-operations-candidate.mjs';
import {
  CURRENT_PACKAGE_RESOLUTION,
  EXAM_OPERATIONS_CURRENT_STATE_SCHEMA,
  buildExamOperationsCurrentState,
} from './backend-exam-publication/exam-operations-current-state.mjs';
import {
  EXAM_OPERATIONS_HEALTH_SCHEMA,
  createExamOperationsHealth,
} from './backend-exam-publication/exam-operations-health.mjs';
import {
  EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA,
  RELEASE_CHANGE_CLASSIFICATIONS,
  createCandidateQuestionFingerprintIndex,
  createExamOperationsReleaseDiff,
} from './backend-exam-publication/exam-operations-release-diff.mjs';
import { assertSanitizedExamOperationsOutput } from './backend-exam-publication/exam-operations-output-safety.mjs';
import {
  buildExamOperationsCapabilityQuery,
  buildExamOperationsReadQuery,
  parseSupabaseQueryOutput,
} from './exam-operations/read-production-state.mjs';

const tests = [];

test('current-state snapshot resolves one enabled published package through defaults', () => {
  const built = currentBuild(basicCandidate({ packageVersion: '1.0.0' }));
  assert.equal(built.snapshot.currentStateSchema, EXAM_OPERATIONS_CURRENT_STATE_SCHEMA);
  assert.equal(built.snapshot.resolution.status, CURRENT_PACKAGE_RESOLUTION.resolved);
  assert.equal(built.snapshot.currentPackage.packageVersion, '1.0.0');
  assert.equal(built.snapshot.currentPackage.inventory.totalItemCount, 2);
  assert.equal(built.snapshot.dataAvailability.sourceHash, 'NOT_AVAILABLE');
});

test('ambiguous defaults across package versions stop current-package selection', () => {
  const raw = rawState(basicCandidate({ packageVersion: '1.0.0' }));
  raw.packages.push({ ...raw.packages[0], internalPackageId: 'pkg-other', packageVersion: '2.0.0' });
  raw.profiles.push({ ...raw.profiles[0], internalPackageId: 'pkg-other', internalProfileId: 'profile-other' });
  raw.defaults.push({
    internalPackageId: 'pkg-other', internalProfileId: 'profile-other', packageVersion: '2.0.0',
    profileKey: 'full-profile', purpose: 'weak_area', enabled: true,
  });
  raw.activations.push({
    internalPackageId: 'pkg-other', internalProfileId: 'profile-other', packageVersion: '2.0.0',
    profileKey: 'full-profile', activationKind: 'production', enabled: true,
  });
  const built = buildExamOperationsCurrentState(raw, 'synthetic100');
  assert.equal(built.snapshot.resolution.status, CURRENT_PACKAGE_RESOLUTION.ambiguous);
  assert.equal(built.snapshot.currentPackage, null);
});

test('invalid default profile binding is blocked rather than guessed', () => {
  const raw = rawState(basicCandidate({ packageVersion: '1.0.0' }));
  raw.defaults[0].internalProfileId = 'missing-profile';
  const built = buildExamOperationsCurrentState(raw, 'synthetic100');
  assert.equal(built.snapshot.resolution.status, CURRENT_PACKAGE_RESOLUTION.invalid);
  assert.ok(built.snapshot.resolution.findingCodes.includes('DEFAULT_BINDING_INVALID'));
});

test('identical current and candidate produce NO_CHANGE', () => {
  const contract = basicCandidate({ packageVersion: '1.0.0' });
  const result = releaseDiff(contract, structuredClone(contract));
  assert.equal(result.overallChangeClassification, RELEASE_CHANGE_CLASSIFICATIONS.noChange);
  assert.equal(result.questionInventory.unchangedCount, 2);
});

test('version bump alone does not create false question or release changes', () => {
  const current = basicCandidate({ packageVersion: '1.0.0' });
  const candidate = structuredClone(current);
  candidate.exam.packageVersion = '2.0.0';
  const result = releaseDiff(current, candidate);
  assert.equal(result.overallChangeClassification, RELEASE_CHANGE_CLASSIFICATIONS.noChange);
  assert.equal(result.questionInventory.changedCount, 0);
});

test('same question identity and content hash is unchanged', () => {
  const result = releaseDiff(basicCandidate(), basicCandidate());
  assert.equal(result.questionInventory.unchangedCount, 2);
  assert.equal(result.exactHashReport.crossVersionUnchangedContentCount, 2);
});

test('same identity with changed content hash is changed', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.questions[0].presentation.prompt = 'Changed synthetic wording.';
  const result = releaseDiff(current, candidate);
  assert.equal(result.questionInventory.changedCount, 1);
  assert.ok(result.changeDimensions.includes('CONTENT_CHANGE'));
});

test('new identity is counted as added', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.questions.push(standardQuestion('standard-3'));
  candidate.profiles[0].questionCount = 3;
  candidate.profiles[0].selection.standardQuestionCount = 3;
  const result = releaseDiff(current, candidate);
  assert.equal(result.questionInventory.addedCount, 1);
  assert.equal(result.questionInventory.candidateComparableInventory, 3);
});

test('removed identity is counted as removed', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.questions.pop();
  candidate.profiles[0].questionCount = 1;
  candidate.profiles[0].selection.standardQuestionCount = 1;
  const result = releaseDiff(current, candidate);
  assert.equal(result.questionInventory.removedCount, 1);
  assert.equal(result.questionInventory.currentComparableInventory, 2);
});

test('stable content under a different identity produces CONTENT_REUSE_WARNING', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.questions[0].id = 'renamed-identity';
  const result = releaseDiff(current, candidate);
  assert.equal(result.questionInventory.addedCount, 1);
  assert.equal(result.questionInventory.removedCount, 1);
  assert.equal(result.exactHashReport.crossVersionSameHashUnderDifferentIdentityCount, 1);
  assert.ok(result.exactHashReport.findingCodes.includes('CONTENT_REUSE_WARNING'));
});

test('duplicate candidate identity is an exact duplicate error and invalid candidate', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.questions[1].id = candidate.questions[0].id;
  const result = releaseDiff(current, candidate);
  assert.equal(result.overallChangeClassification, RELEASE_CHANGE_CLASSIFICATIONS.invalid);
  assert.equal(result.exactHashReport.duplicateStableIdentityCount, 1);
  assert.ok(result.exactHashReport.findingCodes.includes('EXACT_DUPLICATE_ERROR'));
});

test('exact candidate content reuse reports aggregate hash counts only', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  const reused = structuredClone(candidate.questions[0]);
  reused.id = 'reused-content-new-identity';
  candidate.questions.push(reused);
  candidate.profiles[0].questionCount = 3;
  candidate.profiles[0].selection.standardQuestionCount = 3;
  const result = releaseDiff(current, candidate);
  assert.equal(result.exactHashReport.duplicateCanonicalContentHashCount, 1);
  assert.equal(result.exactHashReport.identicalContentReusedUnderMultipleIdentitiesCount, 1);
});

test('release diff never serializes raw question identities', () => {
  const result = releaseDiff(basicCandidate(), basicCandidate());
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('standard-1'), false);
  assert.equal(serialized.includes('standard-2'), false);
  assert.doesNotThrow(() => assertSanitizedExamOperationsOutput(result));
});

test('question comparison unavailable is explicit and never guessed', () => {
  const current = basicCandidate();
  const candidate = basicCandidate();
  const built = currentBuild(current);
  const validation = validateCandidate(candidate, built.snapshot.currentPackage.packageVersion);
  const result = createExamOperationsReleaseDiff({
    currentState: built.snapshot,
    candidateValidation: validation,
    currentFingerprintIndex: null,
    candidateContract: candidate,
  });
  assert.equal(result.questionInventory.status, 'QUESTION_IDENTITY_COMPARISON_UNAVAILABLE');
  assert.equal(result.questionInventory.changedCount, null);
});

test('timer-only profile change is a PROFILE_CHANGE', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.profiles[0].timeLimitMinutes = 45;
  const result = releaseDiff(current, candidate);
  assert.equal(result.overallChangeClassification, RELEASE_CHANGE_CLASSIFICATIONS.profile);
  assert.ok(result.profiles.changedProfiles[0].changes.some((entry) => entry.field === 'timeLimitMinutes'));
});

test('standard count change is reported at field level', () => {
  const candidate = mixedCandidate();
  const result = releaseDiff(candidate, candidate, (raw) => {
    raw.profiles[0].standardQuestionCount = 4;
    raw.profiles[0].caseStudyQuestionCount = 1;
  });
  assert.ok(changedProfileFields(result).includes('standardQuestionCount'));
});

test('case-study composition change is reported', () => {
  const candidate = mixedCandidate();
  const result = releaseDiff(candidate, candidate, (raw) => {
    raw.profiles[0].standardQuestionCount = 5;
    raw.profiles[0].caseStudyCount = 0;
    raw.profiles[0].caseStudyQuestionCount = 0;
    raw.profiles[0].sectionOrder = 'standard-pbq';
  });
  assert.ok(changedProfileFields(result).includes('caseStudyCount'));
  assert.ok(changedProfileFields(result).includes('scoredCaseQuestionCount'));
});

test('PBQ count change is reported', () => {
  const candidate = mixedCandidate();
  const result = releaseDiff(candidate, candidate, (raw) => {
    raw.profiles[0].standardQuestionCount = 4;
    raw.profiles[0].pbqCount = 0;
    raw.profiles[0].sectionOrder = 'case-standard';
  });
  assert.ok(changedProfileFields(result).includes('pbqCount'));
});

test('executable count change is reported', () => {
  const candidate = executableBlendCandidate();
  const result = releaseDiff(candidate, candidate, (raw) => {
    raw.profiles[0].standardQuestionCount = 2;
    raw.profiles[0].executableCount = 0;
    raw.profiles[0].sectionOrder = 'standard';
  });
  assert.ok(changedProfileFields(result).includes('executableCount'));
});

test('section order change is reported without exposing selection internals', () => {
  const candidate = mixedCandidate();
  const result = releaseDiff(candidate, candidate, (raw) => {
    raw.profiles[0].sectionOrder = 'standard-case-pbq';
  });
  assert.ok(changedProfileFields(result).includes('sectionOrder'));
  assert.equal(JSON.stringify(result).includes('selection_config'), false);
});

test('profile additions and removals are both deterministic', () => {
  const current = basicCandidate();
  const withSecond = structuredClone(current);
  withSecond.profiles.push({
    ...structuredClone(withSecond.profiles[0]),
    profileKey: 'second-profile',
    displayName: 'Second',
  });
  const added = releaseDiff(current, withSecond);
  const removed = releaseDiff(withSecond, current);
  assert.deepEqual(added.profiles.addedProfiles, ['second-profile']);
  assert.deepEqual(removed.profiles.removedProfiles, ['second-profile']);
});

test('unchanged fixed forms remain unchanged', () => {
  const contract = fixedFormsCandidate();
  const result = releaseDiff(contract, structuredClone(contract));
  assert.equal(result.forms.formsUnchanged, 2);
  assert.equal(result.forms.formsChanged, 0);
});

test('form membership hash changes are counted without member identities', () => {
  const current = fixedFormsCandidate();
  const candidate = structuredClone(current);
  const forms = candidate.profiles[0].selection.canonicalForms.forms;
  forms[0].questionIds = ['fixed-q-1', 'fixed-q-3'];
  forms[1].questionIds = ['fixed-q-2', 'fixed-q-4'];
  forms.forEach((form) => { form.membershipHash = sha256Canonical(form.questionIds); });
  const result = releaseDiff(current, candidate);
  assert.equal(result.forms.formsChanged, 2);
  assert.equal(JSON.stringify(result).includes('fixed-q-1'), false);
});

test('reserve count change is reported as a safe aggregate', () => {
  const current = fixedFormsCandidate();
  const candidate = structuredClone(current);
  candidate.questions.push(standardQuestion('fixed-q-6'));
  candidate.profiles[0].selection.canonicalForms.reserveQuestionIds.push('fixed-q-6');
  const result = releaseDiff(current, candidate);
  assert.equal(result.forms.profiles[0].aggregates.reserveItemCount.delta, 1);
});

test('dynamic profile forms are NOT_APPLICABLE', () => {
  const result = releaseDiff(basicCandidate(), basicCandidate());
  assert.equal(result.forms.profiles[0].state, 'NOT_APPLICABLE');
});

test('runtime and capability changes use Phase 2 compatibility logic', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.runtime.generatorVersion = 'unsupported-generator-v9';
  const result = releaseDiff(current, candidate);
  assert.equal(result.runtime.generatorVersion.state, 'PLATFORM_CAPABILITY_CHANGE_REQUIRED');
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
});

test('release policy change is obvious and classified as profile configuration', () => {
  const current = basicCandidate();
  const candidate = structuredClone(current);
  candidate.releasePolicy = { review: 'never', answers: 'never' };
  const result = releaseDiff(current, candidate);
  assert.equal(result.releasePolicy.changed, true);
  assert.ok(result.changeDimensions.includes('PROFILE_CHANGE'));
});

test('AZ-400 conceptual successor is content/profile change, not platform capability change', () => {
  const current = az400CurrentCandidate();
  const candidate = correctedAz400Candidate();
  const result = releaseDiff(current, candidate, (raw) => {
    raw.profiles.push({
      ...structuredClone(raw.profiles[0]),
      internalProfileId: 'profile-sectioned',
      profileKey: 'az400-sectioned-full-exam-profile',
      displayName: 'Sectioned',
      standardQuestionCount: null,
      normalScoredQuestionCount: null,
      caseStudyCount: 2,
      caseStudyQuestionCount: null,
      pbqCount: 2,
      sectionOrder: 'case-standard-pbq',
    });
  });
  assert.equal(result.releaseDiffSchema, EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA);
  assert.ok(result.changeDimensions.includes('CONTENT_CHANGE'));
  assert.ok(result.changeDimensions.includes('PROFILE_CHANGE'));
  assert.equal(result.changeDimensions.includes('CAPABILITY_CHANGE'), false);
  assert.equal(result.capabilities.unsupportedAddedCapabilityCount, 0);
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.contentRelease);
});

test('health: one unambiguous published package passes measurable resolution checks', () => {
  const health = healthFor(rawState(basicCandidate({ packageVersion: '1.0.0' })));
  assert.equal(health.healthSchema, EXAM_OPERATIONS_HEALTH_SCHEMA);
  assert.equal(healthCheck(health, 'CURRENT_PACKAGE_RESOLVED').state, 'PASS');
  assert.equal(healthCheck(health, 'PACKAGE_PUBLISHED').state, 'PASS');
});

test('health: ambiguous defaults are BLOCKED', () => {
  const raw = rawState(basicCandidate({ packageVersion: '1.0.0' }));
  raw.packages.push({ ...raw.packages[0], internalPackageId: 'pkg-other', packageVersion: '2.0.0' });
  raw.profiles.push({ ...raw.profiles[0], internalPackageId: 'pkg-other', internalProfileId: 'profile-other' });
  raw.defaults.push({ ...raw.defaults[0], internalPackageId: 'pkg-other', internalProfileId: 'profile-other', packageVersion: '2.0.0', purpose: 'weak_area' });
  const health = healthFor(raw);
  assert.equal(health.overallHealth, 'BLOCKED');
});

test('health: nonexistent default profile is BLOCKED', () => {
  const raw = rawState(basicCandidate());
  raw.defaults[0].internalProfileId = 'missing';
  assert.equal(healthFor(raw).overallHealth, 'BLOCKED');
});

test('health: default package not published is BLOCKED', () => {
  const raw = rawState(basicCandidate(), { packageStatus: 'draft' });
  const health = healthFor(raw);
  assert.equal(healthCheck(health, 'PACKAGE_PUBLISHED').state, 'BLOCKED');
});

test('health: expected activation missing is BLOCKED', () => {
  const raw = rawState(basicCandidate());
  raw.activations = [];
  const health = healthFor(raw);
  assert.equal(healthCheck(health, 'ACTIVATIONS_VALID').state, 'BLOCKED');
});

test('health: required practice policy missing is BLOCKED', () => {
  const raw = rawState(basicCandidate());
  raw.practicePolicies = [];
  const health = healthFor(raw);
  assert.equal(healthCheck(health, 'PRACTICE_POLICIES_VALID').state, 'BLOCKED');
});

test('health: unsupported current runtime is BLOCKED', () => {
  const raw = rawState(basicCandidate());
  raw.packages[0].generatorVersion = 'unsupported-generator-v9';
  const health = healthFor(raw);
  assert.equal(healthCheck(health, 'RUNTIME_SUPPORTED').state, 'BLOCKED');
});

test('health: latest successful publication passes', () => {
  const health = healthFor(rawState(basicCandidate()));
  assert.equal(healthCheck(health, 'LATEST_PUBLICATION_SUCCEEDED').state, 'PASS');
});

test('health: latest failed publication warns', () => {
  const raw = rawState(basicCandidate());
  raw.latestPublication.status = 'failed';
  raw.latestPublication.errorCode = 'publication_validation_failed';
  const health = healthFor(raw);
  assert.equal(healthCheck(health, 'LATEST_PUBLICATION_SUCCEEDED').state, 'WARNING');
});

test('health: active attempt aggregates distinguish timed and untimed practice', () => {
  const raw = rawState(basicCandidate());
  raw.attemptAggregates = [
    { packageVersion: '1.0.0', profileKey: 'full-profile', purpose: 'assigned_assessment', activeCount: 2 },
    { packageVersion: '1.0.0', profileKey: 'full-profile', purpose: 'study_sandbox', activeCount: 3 },
  ];
  const aggregates = healthFor(raw).activeAttemptAggregates;
  assert.equal(aggregates.activeAttemptsTotal, 5);
  assert.equal(aggregates.activeTimedAttempts, 2);
  assert.equal(aggregates.activePracticeAttempts, 3);
});

test('health: predecessor active attempts are aggregated without identities', () => {
  const raw = rawState(basicCandidate());
  addOlderOperationalState(raw);
  raw.attemptAggregates = [
    { packageVersion: '0.9.0', profileKey: 'full-profile', purpose: 'assigned_assessment', activeCount: 2 },
  ];
  const health = healthFor(raw);
  assert.equal(health.activeAttemptAggregates.activeAttemptsOlderPackage, 2);
  assert.equal(health.predecessorContinuation.state, 'CONTINUATION_SAFE_AS_CONFIGURED');
});

test('health: predecessor practice attempt surfaces continuation dependency', () => {
  const raw = rawState(basicCandidate());
  addOlderOperationalState(raw);
  raw.attemptAggregates = [
    { packageVersion: '0.9.0', profileKey: 'full-profile', purpose: 'study_sandbox', activeCount: 1 },
  ];
  const health = healthFor(raw);
  assert.equal(health.predecessorContinuation.state, 'PREDECESSOR_CONTINUATION_DEPENDENCY_PRESENT');
  assert.equal(healthCheck(health, 'PREDECESSOR_CONTINUATION').state, 'WARNING');
});

test('health: absent predecessor attempts are explicit', () => {
  const health = healthFor(rawState(basicCandidate()));
  assert.equal(health.predecessorContinuation.state, 'NO_ACTIVE_PREDECESSOR_ATTEMPTS');
});

test('health: unavailable save telemetry remains NOT_AVAILABLE', () => {
  const health = healthFor(rawState(basicCandidate()));
  assert.equal(healthCheck(health, 'SAVE_FAILURE_TELEMETRY').state, 'NOT_AVAILABLE');
});

test('health: unavailable submit telemetry remains NOT_AVAILABLE', () => {
  const health = healthFor(rawState(basicCandidate()));
  assert.equal(healthCheck(health, 'SUBMIT_FAILURE_TELEMETRY').state, 'NOT_AVAILABLE');
});

test('health: unavailable deployment correlation remains NOT_AVAILABLE', () => {
  const health = healthFor(rawState(basicCandidate()));
  assert.equal(healthCheck(health, 'DEPLOYMENT_CORRELATION').state, 'NOT_AVAILABLE');
  assert.deepEqual(health.unavailableTelemetryFields, [
    'SAVE_FAILURE_TELEMETRY',
    'SUBMIT_FAILURE_TELEMETRY',
    'DEPLOYMENT_CORRELATION',
    'POST_RELEASE_HEALTH_EVENT',
  ]);
  assert.equal(health.overallHealth, 'WARNING');
});

test('health output excludes PII and protected content', () => {
  const raw = rawState(basicCandidate());
  raw.unusedSensitiveFixture = {
    learner: '00000000-0000-4000-8000-000000000001',
    email: 'learner@example.invalid',
    prompt: 'PROTECTED HEALTH SENTINEL',
  };
  const serialized = JSON.stringify(healthFor(raw));
  assert.equal(serialized.includes('learner@example.invalid'), false);
  assert.equal(serialized.includes('PROTECTED HEALTH SENTINEL'), false);
  assert.equal(serialized.includes('00000000-0000-4000-8000-000000000001'), false);
});

test('custody validator rejects forbidden identity and email fields', () => {
  assert.throws(
    () => assertSanitizedExamOperationsOutput({ questionId: 'private-q' }),
    /EXAMOPS_PROTECTED_FIELD_REJECTED/,
  );
  assert.throws(
    () => assertSanitizedExamOperationsOutput({ note: 'learner@example.invalid' }),
    /EXAMOPS_SENSITIVE_VALUE_REJECTED/,
  );
});

test('fixed production query is read-only and encodes authoritative active-attempt rules', () => {
  const query = buildExamOperationsReadQuery('az400');
  assert.match(query, /^with\s/i);
  assert.doesNotMatch(query, /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/i);
  assert.match(query, /a\.expires_at>statement_timestamp\(\)/);
  assert.match(query, /a\.practice_idle_expires_at>statement_timestamp\(\)/);
  assert.match(query, /replacement\.replaced_attempt_id=a\.id/);
  assert.match(query, /expiration\.expired_attempt_id=a\.id/);
  assert.doesNotMatch(query, /scoring_payload|review_payload/);
});

test('production query capability-detects and surfaces successful generic release history', () => {
  const capability = buildExamOperationsCapabilityQuery();
  const legacyQuery = buildExamOperationsReadQuery('az400');
  const genericQuery = buildExamOperationsReadQuery('az400', {
    genericReleaseOperations: true,
  });
  assert.match(capability, /to_regclass\('exam_delivery\.exam_release_operations'\)/);
  assert.doesNotMatch(capability, /\b(insert|update|delete|alter|drop|create|grant|revoke)\b/i);
  assert.doesNotMatch(legacyQuery, /from exam_delivery\.exam_release_operations operation/);
  assert.match(genericQuery, /from exam_delivery\.exam_release_operations operation/);
  assert.match(genericQuery, /where operation\.result_state='succeeded'/);
  assert.match(genericQuery, /operation\.operation_type in \('ACTIVATE','ROLLBACK'\)/);
  assert.match(genericQuery, /'source','generic-exam-operations'/);
  assert.doesNotMatch(genericQuery, /scoring_payload|review_payload/);
});

test('linked CLI JSON parser ignores informational prefix/suffix without echoing rows', () => {
  const parsed = parseSupabaseQueryOutput([
    'Initialising login role...',
    JSON.stringify({ rows: [{ snapshot: { examKey: 'az400', packages: [] } }] }),
    'A new version is available',
  ].join('\n'));
  assert.deepEqual(parsed, { examKey: 'az400', packages: [] });
});

test('Phase 3 adds commands and no migration source', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.scripts['examops:diff'], 'node scripts/diff-exam-operations-release.mjs');
  assert.equal(packageJson.scripts['examops:health'], 'node scripts/check-exam-operations-health.mjs');
  assert.equal(packageJson.scripts['validate:issue133:phase3'], 'node scripts/validate-issue133-examops-phase3.mjs');
  const source = await readFile('scripts/exam-operations/read-production-state.mjs', 'utf8');
  assert.doesNotMatch(source, /SUPABASE_(?:SERVICE_ROLE|DB_PASSWORD|ACCESS_TOKEN)/);
});

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
console.log(`Issue #133 Phase 3 validation passed (${tests.length} tests).`);

function test(name, run) {
  tests.push({ name, run });
}

function releaseDiff(currentContract, candidateContract, mutateRaw = () => {}) {
  const raw = rawState(currentContract);
  mutateRaw(raw);
  const built = buildExamOperationsCurrentState(raw, currentContract.exam.examKey);
  const validation = validateCandidate(
    candidateContract,
    built.snapshot.currentPackage?.packageVersion,
  );
  return createExamOperationsReleaseDiff({
    currentState: built.snapshot,
    candidateValidation: validation,
    currentFingerprintIndex: built.privateComparisonIndex,
    candidateContract,
  });
}

function validateCandidate(contract, currentPackageVersion = '1.0.0') {
  return validateExamOperationsCandidate(contract, {
    currentPackageVersion,
    predecessorPackageVersion: currentPackageVersion,
  });
}

function currentBuild(contract, options = {}) {
  return buildExamOperationsCurrentState(
    rawState(contract, options),
    contract.exam.examKey,
  );
}

function healthFor(raw) {
  return createExamOperationsHealth(
    buildExamOperationsCurrentState(raw, raw.examKey),
  );
}

function healthCheck(health, code) {
  return health.checks.find((entry) => entry.code === code);
}

function changedProfileFields(diff) {
  return diff.profiles.changedProfiles.flatMap((profile) => (
    profile.changes.map((entry) => entry.field)
  ));
}

function rawState(contract, options = {}) {
  const manifest = validateCandidate(contract).manifest;
  assert.ok(manifest, 'fixture must produce a manifest');
  const internalPackageId = 'pkg-current';
  const profiles = contract.profiles.map((profile, index) => ({
    internalPackageId,
    internalProfileId: `profile-${index + 1}`,
    profileKey: profile.profileKey,
    displayName: profile.displayName,
    questionCount: profile.questionCount,
    timeLimitMinutes: profile.timeLimitMinutes,
    standardQuestionCount: integerOrNull(profile.selection?.standardQuestionCount),
    normalScoredQuestionCount: integerOrNull(profile.selection?.normalScoredQuestionCount),
    caseStudyCount: integerOrNull(profile.selection?.caseStudyCount),
    longCaseStudyCount: integerOrNull(profile.selection?.longCaseStudyCount),
    shortCaseStudyCount: integerOrNull(profile.selection?.shortCaseStudyCount),
    caseStudyQuestionCount: integerOrNull(profile.selection?.caseStudyQuestionCount),
    pbqCount: integerOrNull(profile.selection?.pbqCount),
    executableCount: integerOrNull(profile.selection?.executableCount),
    sectionOrder: profile.selection?.sectionOrder ?? null,
    formContractVersion: profile.selection?.canonicalForms?.contractVersion ?? null,
  }));
  const fingerprints = createCandidateQuestionFingerprintIndex(contract);
  const questionRecords = contract.questions.map((question, index) => ({
    internalPackageId,
    questionIdentity: question.id,
    contentHash: fingerprints[index].contentHash,
    interactionType: question.type,
    domainKey: question.domainKey,
    objectiveKey: question.sectionKey ?? question.presentation?.officialObjectiveKey ?? null,
    scored: question.scored !== false,
    caseRole: question.group?.role ?? null,
  }));
  const forms = [];
  for (let index = 0; index < contract.profiles.length; index += 1) {
    const source = contract.profiles[index].selection?.canonicalForms;
    for (const form of source?.forms ?? []) {
      forms.push({
        internalPackageId,
        internalProfileId: profiles[index].internalProfileId,
        formOrdinal: form.ordinal,
        membershipHash: form.membershipHash,
        itemCount: form.questionIds.length,
        scoredItemCount: form.questionIds.length,
      });
    }
  }
  const defaults = profiles.flatMap((profile) => ([
    {
      internalPackageId,
      internalProfileId: profile.internalProfileId,
      packageVersion: contract.exam.packageVersion,
      profileKey: profile.profileKey,
      purpose: 'assigned_assessment',
      enabled: true,
    },
    {
      internalPackageId,
      internalProfileId: profile.internalProfileId,
      packageVersion: contract.exam.packageVersion,
      profileKey: profile.profileKey,
      purpose: 'self_directed_exam',
      enabled: true,
    },
  ]));
  const activations = profiles.map((profile) => ({
    internalPackageId,
    internalProfileId: profile.internalProfileId,
    packageVersion: contract.exam.packageVersion,
    profileKey: profile.profileKey,
    activationKind: 'production',
    enabled: true,
  }));
  const practicePolicies = profiles.map((profile) => ({
    internalPackageId,
    internalProfileId: profile.internalProfileId,
    packageVersion: contract.exam.packageVersion,
    profileKey: profile.profileKey,
    purpose: 'self_directed_exam',
    enabled: true,
    accessMode: 'production_authorized',
    maximumSessionItems: profile.questionCount,
    immediateFeedback: false,
    reviewReleasePolicy: contract.releasePolicy.review,
    answerReleasePolicy: contract.releasePolicy.answers,
  }));
  const caseGroups = new Set(contract.questions
    .filter((question) => question.group?.role === 'context')
    .map((question) => question.group.groupKey));
  const reserve = contract.profiles[0]?.selection?.canonicalForms?.reserveQuestionIds ?? [];
  return {
    examKey: contract.exam.examKey,
    observedAt: '2026-09-19T12:00:00.000Z',
    packages: [{
      internalPackageId,
      packageVersion: contract.exam.packageVersion,
      status: options.packageStatus ?? 'published',
      supersedesInternalPackageId: null,
      validationHash: contract.source.validationHash,
      packageHash: sha256Canonical(contract),
      packageSchemaVersion: contract.packageSchemaVersion,
      generatorVersion: contract.runtime.generatorVersion,
      scorerVersion: contract.runtime.scorerVersion,
      declaredReviewReleasePolicy: contract.releasePolicy.review,
      declaredAnswerReleasePolicy: contract.releasePolicy.answers,
      publishedAt: '2026-09-18T12:00:00.000Z',
    }],
    profiles,
    questionRecords,
    forms,
    packageStats: [{
      internalPackageId,
      caseStudyGroupCount: caseGroups.size,
      reserveItemCount: reserve.length,
    }],
    defaults,
    activations,
    practicePolicies,
    attemptAggregates: [],
    latestPublication: {
      packageVersion: contract.exam.packageVersion,
      status: 'succeeded',
      errorCode: null,
      createdAt: '2026-09-18T11:59:00.000Z',
      completedAt: '2026-09-18T12:00:00.000Z',
    },
    latestReleaseConfiguration: {
      packageVersion: contract.exam.packageVersion,
      profileKey: contract.profiles[0].profileKey,
      releaseStage: 'standard_active_exam_v1',
      configuredAt: '2026-09-18T12:01:00.000Z',
    },
  };
}

function addOlderOperationalState(raw) {
  raw.packages.push({
    ...raw.packages[0],
    internalPackageId: 'pkg-older',
    packageVersion: '0.9.0',
    status: 'superseded',
  });
  raw.activations.push({
    internalPackageId: 'pkg-older',
    internalProfileId: 'profile-older',
    packageVersion: '0.9.0',
    profileKey: 'full-profile',
    activationKind: 'production',
    enabled: true,
  });
  raw.practicePolicies.push({
    internalPackageId: 'pkg-older',
    internalProfileId: 'profile-older',
    packageVersion: '0.9.0',
    profileKey: 'full-profile',
    purpose: 'study_sandbox',
    enabled: true,
    accessMode: 'production_authorized',
    maximumSessionItems: null,
    immediateFeedback: true,
    reviewReleasePolicy: 'immediate_study_feedback',
    answerReleasePolicy: 'immediate_study_feedback',
  });
}

function basicCandidate({ packageVersion = '1.0.0' } = {}) {
  return {
    packageSchemaVersion: 'certsim-protected-package-v2',
    validationContractVersion: 'certsim-protected-multi-exam-validation-v1',
    exam: {
      examKey: 'synthetic100',
      packageVersion,
      capabilities: ['single-choice'],
      domains: [{ key: 'domain-a', name: 'Synthetic domain' }],
    },
    source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
    runtime: standardRuntime(),
    profiles: [{
      profileKey: 'full-profile',
      displayName: 'Full',
      questionCount: 2,
      timeLimitMinutes: 30,
      selection: { standardQuestionCount: 2, sectionOrder: 'standard' },
    }],
    releasePolicy: { review: 'after_submission', answers: 'after_submission' },
    questions: [standardQuestion('standard-1'), standardQuestion('standard-2')],
  };
}

function standardQuestion(id, overrides = {}) {
  return {
    id,
    type: 'single-choice',
    domainKey: 'domain-a',
    sectionKey: 'objective-a',
    scored: true,
    presentation: {
      prompt: `Synthetic fixture prompt for ${id}.`,
      options: [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }],
    },
    privateScoring: { correctOptionIds: ['a'], maximumRawPoints: 1 },
    privateReview: { rationale: 'Synthetic private review.' },
    ...overrides,
  };
}

function contextQuestion(id, groupKey) {
  return {
    id,
    type: 'case-study-context',
    domainKey: 'domain-a',
    scored: false,
    group: { groupKey, groupSize: 'long', role: 'context', order: 0 },
    presentation: { heading: 'Synthetic case context.' },
    privateReview: {},
  };
}

function caseChild(id, groupKey, order) {
  return standardQuestion(id, {
    group: { groupKey, groupSize: 'long', role: 'question', order },
  });
}

function pbqQuestion(id) {
  return standardQuestion(id, {
    type: 'pbq-config-panel',
    presentation: { interactionVersion: 'pbq-config-panel', responseAllowlist: {} },
    privateScoring: { strategy: 'exact-whole-state', maximumRawPoints: 1 },
  });
}

function executableQuestion(id) {
  const gradingMaterial = {
    contractVersion: 'certsim-python-trusted-grading-v1',
    taskId: id,
    maximumRawPoints: 1,
    rules: [{
      type: 'ast_absence',
      compiled: {
        contractVersion: 'certsim-python-trusted-grading-v1',
        family: 'ast_absence',
        forbiddenCalls: ['eval'],
        forbiddenAttributes: [],
      },
      points: 1,
    }],
  };
  return {
    id,
    type: 'executable-python-lab-v1',
    domainKey: 'domain-a',
    sectionKey: 'objective-a',
    scored: true,
    presentation: {
      interactionVersion: 'executable-python-lab-v1',
      language: 'python',
      starterCode: '# synthetic fixture',
      editableFiles: ['main.py'],
    },
    privateScoring: {
      maximumRawPoints: 1,
      trustedGrading: {
        status: 'compiled',
        materialDigest: sha256Canonical(gradingMaterial),
        gradingMaterial,
      },
    },
    privateReview: { rationale: 'Synthetic private review.' },
  };
}

function mixedCandidate() {
  const contract = basicCandidate();
  contract.exam.capabilities = ['single-choice', 'case-study-context', 'pbq-config-panel'];
  contract.runtime = az400Runtime();
  contract.questions = [
    standardQuestion('mixed-standard-1'),
    standardQuestion('mixed-standard-2'),
    standardQuestion('mixed-standard-3'),
    contextQuestion('mixed-context', 'mixed-case'),
    caseChild('mixed-case-1', 'mixed-case', 1),
    caseChild('mixed-case-2', 'mixed-case', 2),
    pbqQuestion('mixed-pbq'),
  ];
  contract.profiles[0] = {
    profileKey: 'full-profile',
    displayName: 'Full',
    questionCount: 6,
    timeLimitMinutes: 60,
    selection: {
      standardQuestionCount: 3,
      caseStudyCount: 1,
      caseStudyQuestionCount: 2,
      pbqCount: 1,
      sectionOrder: 'case-standard-pbq',
    },
  };
  return contract;
}

function executableBlendCandidate() {
  const contract = basicCandidate();
  contract.exam.capabilities = ['single-choice', 'executable-python-lab-v1'];
  contract.runtime = {
    generatorVersion: 'certsim-python-next-generation-canonical-forms-v1',
    scorerVersion: 'certsim-python-trusted-grading-v1',
  };
  contract.questions = [standardQuestion('python-standard'), executableQuestion('python-lab')];
  contract.profiles[0].selection = {
    standardQuestionCount: 1,
    executableCount: 1,
    sectionOrder: 'standard-executable',
  };
  return contract;
}

function fixedFormsCandidate() {
  const contract = basicCandidate();
  contract.runtime = {
    generatorVersion: 'certsim-python-standard-canonical-forms-v1',
    scorerVersion: 'certsim-versioned-structured-partial-v1',
  };
  contract.questions = Array.from({ length: 5 }, (_, index) => standardQuestion(`fixed-q-${index + 1}`));
  const first = ['fixed-q-1', 'fixed-q-2'];
  const second = ['fixed-q-3', 'fixed-q-4'];
  contract.profiles[0].selection = {
    canonicalForms: {
      contractVersion: 'certsim-python-standard-forms-v1',
      cycleLength: 2,
      reservePolicy: 'profile-specific-reserve',
      reserveQuestionIds: ['fixed-q-5'],
      forms: [
        { formKey: 'form-a', ordinal: 1, questionIds: first, membershipHash: sha256Canonical(first), rawMaximum: 2 },
        { formKey: 'form-b', ordinal: 2, questionIds: second, membershipHash: sha256Canonical(second), rawMaximum: 2 },
      ],
    },
  };
  return contract;
}

function az400CurrentCandidate() {
  const contract = basicCandidate();
  contract.exam.examKey = 'az400';
  contract.exam.packageVersion = '1.0.0';
  contract.exam.capabilities = ['single-choice'];
  contract.runtime = az400Runtime();
  delete contract.runtime.pbqRuntimeVersion;
  contract.questions = Array.from({ length: 80 }, (_, index) => standardQuestion(`current-${index + 1}`));
  contract.profiles[0] = {
    profileKey: 'az400-full-exam-profile',
    displayName: 'Full',
    questionCount: 80,
    timeLimitMinutes: 120,
    selection: { standardQuestionCount: 80, sectionOrder: 'standard' },
  };
  return contract;
}

function correctedAz400Candidate() {
  const contract = basicCandidate();
  contract.exam.examKey = 'az400';
  contract.exam.packageVersion = '1.1.0';
  contract.exam.capabilities = ['single-choice', 'case-study-context', 'pbq-config-panel'];
  contract.runtime = az400Runtime();
  const questions = Array.from({ length: 66 }, (_, index) => standardQuestion(`successor-${index + 1}`));
  for (let caseIndex = 1; caseIndex <= 2; caseIndex += 1) {
    const key = `successor-case-${caseIndex}`;
    questions.push(contextQuestion(`successor-context-${caseIndex}`, key));
    for (let child = 1; child <= 6; child += 1) {
      questions.push(caseChild(`successor-case-${caseIndex}-${child}`, key, child));
    }
  }
  questions.push(pbqQuestion('successor-pbq-1'), pbqQuestion('successor-pbq-2'));
  contract.questions = questions;
  contract.profiles[0] = {
    profileKey: 'az400-sectioned-full-exam-profile',
    displayName: 'Sectioned',
    questionCount: 80,
    timeLimitMinutes: 120,
    selection: {
      normalScoredQuestionCount: 66,
      caseStudyCount: 2,
      pbqCount: 2,
      sectionOrder: 'case-standard-pbq',
    },
  };
  return contract;
}

function standardRuntime() {
  return {
    generatorVersion: 'certsim-ai901-weighted-generator-v2',
    scorerVersion: 'certsim-ai901-exact-scorer-v2',
  };
}

function az400Runtime() {
  return {
    generatorVersion: 'certsim-az400-case-workspace-generator-v1',
    scorerVersion: 'certsim-az400-authoritative-scorer-v1',
    pbqRuntimeVersion: 'certsim-protected-pbq-runtime-v1',
  };
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
