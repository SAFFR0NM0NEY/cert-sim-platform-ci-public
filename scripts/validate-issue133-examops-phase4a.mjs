import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  PREFLIGHT_OUTCOMES,
  PRACTICE_PURPOSES,
  RELEASE_PURPOSES,
  ReleaseModelError,
  activateExamRelease,
  authorizeAttemptContinuation,
  canonicalHash,
  createAssignment,
  createAttempt,
  createFixture,
  createReleaseSet,
  listReleaseOperationHistory,
  preflightExamRelease,
  releaseConfigurationHash,
  releaseConfigurationSnapshot,
  resolveAssignedStart,
  resolveNewStart,
  rollbackExamRelease,
  stageExamRelease,
} from './exam-operations/phase4a-release-transaction-model.mjs';

const tests = [];

test('1. successor activation with zero predecessor active attempts is safe', () => {
  const { state, activation } = activateFixture();
  assert.equal(activation.ok, true);
  assert.equal(activation.outcome, PREFLIGHT_OUTCOMES.safe);
  assert.equal(state.config.catalog.currentVersion, '2.0.0');
});

test('2. predecessor timed attempt is preserved by immutable continuation contract', () => {
  const attempt = createAttempt({ purpose: 'assigned_assessment' });
  const { activation } = activateFixture({ attempts: [attempt] });
  assert.equal(activation.outcome, PREFLIGHT_OUTCOMES.preserved);
});

test('3. predecessor Study Sandbox survives cutover', () => {
  assertPracticeCutover('study_sandbox');
});

test('4. predecessor Weak Area attempt survives cutover', () => {
  assertPracticeCutover('weak_area');
});

test('5. predecessor PBQ Practice survives cutover', () => {
  assertPracticeCutover('pbq_practice');
});

test('targeted-domain and self-directed predecessor continuations are also preserved', () => {
  assertPracticeCutover('targeted_domain');
  assertPracticeCutover('self_directed_exam');
});

test('6. active predecessor Python frozen submission survives natural timer expiry', () => {
  const attempt = createAttempt({
    runtime: 'python',
    frozenSubmission: true,
    expiresAt: '2026-09-20T11:00:00.000Z',
  });
  const { state, activation } = activateFixture({ attempts: [attempt] });
  assert.equal(activation.outcome, PREFLIGHT_OUTCOMES.preserved);
  assert.equal(activation.ok, true);
  assert.equal(authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'final_submit').allowed, true);
  assertModelError(() => authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'learner_run'), 'ATTEMPT_EXPIRED');
  assertModelError(() => authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'workspace_save'), 'ATTEMPT_EXPIRED');
});

test('7. displaced attempt permits resume, save, check, and submit after activation', () => {
  const attempt = createAttempt();
  const { state } = activateFixture({ attempts: [attempt] });
  for (const operation of ['resume', 'save_response', 'check_item', 'submit']) {
    const authorized = authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, operation);
    assert.equal(authorized.allowed, true);
    assert.equal(authorized.packageVersion, '1.0.0');
  }
});

test('8. new starts resolve every profile and purpose to successor', () => {
  const { state } = activateFixture();
  for (const profileKey of ['full', 'compact', 'sectioned']) {
    for (const purpose of RELEASE_PURPOSES) {
      assert.equal(resolveNewStart(state, profileKey, purpose).packageVersion, '2.0.0');
    }
  }
});

test('9. rollback is safe while successor active attempts exist', () => {
  const fixture = activateFixture();
  fixture.state.attempts.push(createAttempt({ id: 'successor-attempt', packageVersion: '2.0.0' }));
  const rollback = rollbackCurrent(fixture);
  assert.equal(rollback.ok, true);
  assert.equal(rollback.outcome, PREFLIGHT_OUTCOMES.preserved);
});

test('10. successor attempts continue after rollback', () => {
  const fixture = activateFixture();
  const attempt = createAttempt({ id: 'successor-attempt', packageVersion: '2.0.0' });
  fixture.state.attempts.push(attempt);
  assert.equal(rollbackCurrent(fixture).ok, true);
  assert.equal(authorizeAttemptContinuation(fixture.state, attempt.id, attempt.ownerId, 'save_response').packageVersion, '2.0.0');
});

test('11. new starts resolve restored predecessor after rollback', () => {
  const fixture = activateFixture();
  assert.equal(rollbackCurrent(fixture).ok, true);
  for (const purpose of RELEASE_PURPOSES) {
    assert.equal(resolveNewStart(fixture.state, 'full', purpose).packageVersion, '1.0.0');
  }
});

test('12. exact operation replay returns original outcome without duplicate events', () => {
  const state = createFixture();
  const staged = stageFixture(state, 'replay');
  const request = activationRequest(state, staged, 'activate-replay');
  const first = activateExamRelease(state, request);
  const eventCount = state.events.length;
  const operationCount = state.operations.length;
  const second = activateExamRelease(state, request);
  assert.equal(first.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId);
  assert.equal(state.events.length, eventCount);
  assert.equal(state.operations.length, operationCount);
});

test('13. same request ID with a different canonical payload conflicts', () => {
  const state = createFixture();
  const staged = stageFixture(state, 'conflict');
  const request = activationRequest(state, staged, 'activate-conflict');
  assert.equal(activateExamRelease(state, request).ok, true);
  assertModelError(() => activateExamRelease(state, { ...request, expectedCurrentStateHash: 'different' }),
    'REQUEST_ID_PAYLOAD_CONFLICT');
});

test('14. concurrent same-exam operation fails safely under exam-scoped lock', () => {
  const state = createFixture();
  const before = releaseConfigurationHash(state);
  state.locks.add('az400');
  const result = stageExamRelease(state, stageRequest(state, 'locked'));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RELEASE_OPERATION_BUSY');
  assert.equal(releaseConfigurationHash(state), before);
  state.locks.delete('az400');
});

test('15. stale precondition hash blocks activation before mutation', () => {
  const state = createFixture();
  const staged = stageFixture(state, 'stale');
  const before = releaseConfigurationSnapshot(state);
  const request = activationRequest(state, staged, 'activate-stale');
  request.expectedCurrentStateHash = canonicalHash({ stale: true });
  const result = activateExamRelease(state, request);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'RELEASE_STATE_CHANGED');
  assert.deepEqual(releaseConfigurationSnapshot(state), before);
});

test('16. invalid candidate package is blocked', () => {
  const state = createFixture();
  targetPackage(state).valid = false;
  assertBlockedTarget(state, 'TARGET_PACKAGE_INVALID');
});

test('17. unpublished candidate package is blocked', () => {
  const state = createFixture();
  targetPackage(state).published = false;
  assertBlockedTarget(state, 'TARGET_PACKAGE_NOT_PUBLISHED');
});

test('18. runtime-incompatible candidate package is blocked', () => {
  const state = createFixture();
  targetPackage(state).runtimeSupported = false;
  assertBlockedTarget(state, 'TARGET_RUNTIME_INCOMPATIBLE');
});

test('19. candidate missing a release-set profile is blocked', () => {
  const state = createFixture();
  targetPackage(state).profileKeys = ['full', 'compact'];
  assertBlockedTarget(state, 'TARGET_PROFILE_MISSING');
});

test('20. partial purpose update is prohibited', () => {
  const state = createFixture();
  const releaseSet = createReleaseSet();
  releaseSet.profiles[0].purposes.pop();
  const preflight = preflightExamRelease(state, releaseSet);
  assert.equal(preflight.outcome, PREFLIGHT_OUTCOMES.targetInvalid);
  assert.deepEqual(preflight.findingCodes, ['RELEASE_SET_PURPOSE_MISMATCH']);
});

test('21. activation failure leaves all defaults and live configuration unchanged', () => {
  const state = createFixture();
  const staged = stageFixture(state, 'activate-failure');
  const before = releaseConfigurationSnapshot(state);
  const result = activateExamRelease(state, {
    ...activationRequest(state, staged, 'activation-failure'),
    injectFailure: 'after_defaults',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INJECTED_ACTIVATION_FAILURE');
  assert.deepEqual(releaseConfigurationSnapshot(state), before);
});

test('22. rollback failure leaves active successor configuration unchanged', () => {
  const fixture = activateFixture();
  const before = releaseConfigurationSnapshot(fixture.state);
  const result = rollbackExamRelease(fixture.state, {
    requestId: 'rollback-failure',
    rollbackOfOperationId: fixture.activation.operationId,
    expectedCurrentStateHash: releaseConfigurationHash(fixture.state),
    injectFailure: 'after_restore',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INJECTED_ROLLBACK_FAILURE');
  assert.deepEqual(releaseConfigurationSnapshot(fixture.state), before);
});

test('23. cutover and rollback never mutate attempts, assignments, results, or reviews', () => {
  const attempt = createAttempt({ purpose: 'study_sandbox' });
  const assignment = createAssignment();
  const state = createFixture({ attempts: [attempt], assignments: [assignment] });
  const protectedLifecycleState = structuredClone({
    attempts: state.attempts,
    assignments: state.assignments,
    results: state.results,
    reviews: state.reviews,
  });
  const staged = stageFixture(state, 'custody');
  const activation = activateExamRelease(state, activationRequest(state, staged, 'activate-custody'));
  assert.equal(activation.ok, true);
  assert.equal(rollbackCurrent({ state, activation }).ok, true);
  assert.deepEqual({
    attempts: state.attempts,
    assignments: state.assignments,
    results: state.results,
    reviews: state.reviews,
  }, protectedLifecycleState);
});

test('24. append-oriented event history records successful and failed outcomes', () => {
  const state = createFixture();
  const staged = stageFixture(state, 'events');
  const activation = activateExamRelease(state, activationRequest(state, staged, 'activate-events'));
  const failed = rollbackExamRelease(state, {
    requestId: 'rollback-events',
    rollbackOfOperationId: activation.operationId,
    expectedCurrentStateHash: releaseConfigurationHash(state),
    injectFailure: 'after_restore',
  });
  assert.equal(failed.ok, false);
  const activationStates = state.events.filter((event) => event.operationId === activation.operationId)
    .map((event) => event.state);
  const failedStates = state.events.filter((event) => event.operationId === failed.operationId)
    .map((event) => event.state);
  assert.deepEqual(activationStates, ['requested', 'preflighted', 'executing', 'succeeded']);
  assert.deepEqual(failedStates, ['requested', 'preflighted', 'executing', 'failed']);
  assert.equal(listReleaseOperationHistory(state).at(-1).errorCode, 'INJECTED_ROLLBACK_FAILURE');
});

test('stage records intent and evidence without changing any live new-start configuration', () => {
  const state = createFixture();
  const before = releaseConfigurationSnapshot(state);
  const result = stageFixture(state, 'no-live-mutation');
  assert.equal(result.ok, true);
  assert.equal(result.newStartConfigurationChanged, false);
  assert.deepEqual(releaseConfigurationSnapshot(state), before);
});

test('unsafe displaced attempt without continuation contract blocks activation', () => {
  const state = createFixture({ attempts: [createAttempt({ continuationContract: false })] });
  const preflight = preflightExamRelease(state, createReleaseSet());
  assert.equal(preflight.outcome, PREFLIGHT_OUTCOMES.continuationRisk);
  assert.deepEqual(preflight.findingCodes, ['CONTINUATION_CONTRACT_MISSING']);
});

test('continuation retains ownership, active-account, status, timer, and idle-expiry checks', () => {
  const timed = createAttempt({ id: 'timed' });
  const practice = createAttempt({ id: 'practice', purpose: 'weak_area' });
  const state = createFixture({ attempts: [timed, practice] });
  const storedTimed = state.attempts.find((attempt) => attempt.id === timed.id);
  const storedPractice = state.attempts.find((attempt) => attempt.id === practice.id);
  assertModelError(() => authorizeAttemptContinuation(state, storedTimed.id, 'other-owner', 'resume'), 'ATTEMPT_OWNER_MISMATCH');
  storedTimed.accountStatus = 'disabled';
  assertModelError(() => authorizeAttemptContinuation(state, storedTimed.id, storedTimed.ownerId, 'resume'), 'ACCOUNT_INACTIVE');
  storedTimed.accountStatus = 'active';
  storedTimed.status = 'completed';
  assertModelError(() => authorizeAttemptContinuation(state, storedTimed.id, storedTimed.ownerId, 'resume'), 'ATTEMPT_NOT_CONTINUABLE');
  storedTimed.status = 'in_progress';
  storedTimed.expiresAt = '2026-09-20T11:00:00.000Z';
  assertModelError(() => authorizeAttemptContinuation(state, storedTimed.id, storedTimed.ownerId, 'resume'), 'ATTEMPT_EXPIRED');
  storedPractice.practiceIdleExpiresAt = '2026-09-20T11:00:00.000Z';
  assertModelError(() => authorizeAttemptContinuation(state, storedPractice.id, storedPractice.ownerId, 'save_response'), 'ATTEMPT_EXPIRED');
});

test('Python workspace save and learner Run remain available only before expiry', () => {
  const attempt = createAttempt({ runtime: 'python' });
  const state = createFixture({ attempts: [attempt] });
  assert.equal(authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'workspace_save').operation, 'save_response');
  assert.equal(authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'learner_run').operation, 'save_response');
});

test('existing exact assignment stays predecessor-bound while future defaults move', () => {
  const assignment = createAssignment();
  const state = createFixture({ assignments: [assignment] });
  const staged = stageFixture(state, 'exact-assignment');
  const activation = activateExamRelease(state, activationRequest(state, staged, 'activate-exact-assignment'));
  assert.equal(activation.ok, true);
  assert.equal(resolveAssignedStart(state, assignment.id).packageVersion, '1.0.0');
  assert.equal(resolveNewStart(state, assignment.profileKey, 'assigned_assessment').packageVersion, '2.0.0');
  assert.equal(state.assignments[0].packageVersion, '1.0.0');
});

test('release-set shape covers all required purpose-policy bindings exactly once', () => {
  const releaseSet = createReleaseSet();
  for (const profile of releaseSet.profiles) {
    assert.deepEqual(profile.purposes.map((entry) => entry.purpose), RELEASE_PURPOSES);
    assert.deepEqual(profile.practicePolicies.map((entry) => entry.purpose), PRACTICE_PURPOSES);
  }
});

test('only an active Platform Owner can execute a modeled mutation', () => {
  for (const role of ['developer', 'campus_admin', 'trainer', 'learner']) {
    const state = createFixture();
    state.actor.role = role;
    const result = stageExamRelease(state, stageRequest(state, `role-${role}`));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PLATFORM_OWNER_REQUIRED');
  }
});

test('Phase 4A remains architecture history and a pure local model', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const doc = await readFile(path.join(root, 'docs', 'CERTSIM_EXAM_OPERATIONS_PHASE4A.md'), 'utf8');
  const model = await readFile(path.join(root, 'scripts', 'exam-operations', 'phase4a-release-transaction-model.mjs'), 'utf8');
  const migrations = await readdir(path.join(root, 'supabase', 'migrations'));
  assert.match(doc, /Option B — Continuation Decoupling/);
  assert.match(doc, /PHASE4_MIGRATION_REQUIRED/);
  assert.match(doc, /production mutations = 0/);
  assert.doesNotMatch(model, /@supabase|fetch\(|postgres:|https?:\/\//i);
  assert.deepEqual(
    migrations.filter((name) => name.includes('issue133') && name.includes('phase4')),
    ['20260920124528_issue133_examops_phase4b.sql'],
  );
});

function assertPracticeCutover(purpose) {
  const attempt = createAttempt({ purpose });
  const { state, activation } = activateFixture({ attempts: [attempt] });
  assert.equal(activation.outcome, PREFLIGHT_OUTCOMES.preserved);
  assert.equal(authorizeAttemptContinuation(state, attempt.id, attempt.ownerId, 'save_response').allowed, true);
}

function activateFixture({ attempts = [] } = {}) {
  const state = createFixture({ attempts });
  const staged = stageFixture(state, `fixture-${tests.length}-${attempts.length}`);
  assert.equal(staged.ok, true);
  const activation = activateExamRelease(state,
    activationRequest(state, staged, `activate-${tests.length}-${attempts.length}`));
  assert.equal(activation.ok, true);
  return { state, staged, activation };
}

function stageFixture(state, suffix) {
  return stageExamRelease(state, stageRequest(state, suffix));
}

function stageRequest(state, suffix) {
  const releaseSet = createReleaseSet();
  return {
    requestId: `stage-${suffix}`,
    releaseSet,
    evidence: targetEvidence(state),
    expectedCurrentStateHash: releaseConfigurationHash(state),
  };
}

function activationRequest(state, staged, requestId) {
  const stageOperation = state.operations.find((operation) => operation.id === staged.operationId);
  return {
    requestId,
    stageOperationId: staged.operationId,
    releaseSet: structuredClone(stageOperation.releaseSet),
    evidence: structuredClone(stageOperation.evidence),
    expectedCurrentStateHash: releaseConfigurationHash(state),
  };
}

function rollbackCurrent({ state, activation }) {
  return rollbackExamRelease(state, {
    requestId: `rollback-${activation.operationId}`,
    rollbackOfOperationId: activation.operationId,
    expectedCurrentStateHash: releaseConfigurationHash(state),
  });
}

function targetPackage(state) {
  return state.packages.find((entry) => entry.version === '2.0.0');
}

function targetEvidence(state) {
  const pkg = targetPackage(state);
  return {
    packageHash: pkg.packageHash,
    validationHash: pkg.validationHash,
    manifestHash: pkg.manifestHash,
    diffHash: pkg.diffHash,
  };
}

function assertBlockedTarget(state, findingCode) {
  const preflight = preflightExamRelease(state, createReleaseSet());
  assert.equal(preflight.outcome, PREFLIGHT_OUTCOMES.targetInvalid);
  assert.deepEqual(preflight.findingCodes, [findingCode]);
}

function assertModelError(callback, expectedCode) {
  assert.throws(callback, (error) => error instanceof ReleaseModelError && error.code === expectedCode);
}

function test(name, callback) {
  tests.push({ name, callback });
}

let failures = 0;
for (const { name, callback } of tests) {
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error.stack ?? error);
  }
}

if (failures > 0) {
  console.error(`Issue #133 Phase 4A validation failed: ${failures}/${tests.length} tests failed.`);
  process.exit(1);
}

console.log(`Issue #133 Phase 4A validation passed: ${tests.length}/${tests.length} tests.`);
