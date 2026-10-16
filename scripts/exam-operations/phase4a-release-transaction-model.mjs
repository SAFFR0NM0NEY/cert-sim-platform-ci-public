import { createHash } from 'node:crypto';

export const RELEASE_PURPOSES = Object.freeze([
  'assigned_assessment',
  'self_directed_exam',
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
]);

export const PRACTICE_PURPOSES = Object.freeze(RELEASE_PURPOSES.slice(1));

export const PREFLIGHT_OUTCOMES = Object.freeze({
  safe: 'SAFE_TO_ACTIVATE',
  preserved: 'SAFE_WITH_PREDECESSOR_PRESERVATION',
  continuationRisk: 'BLOCKED_CONTINUATION_RISK',
  currentInvalid: 'BLOCKED_CURRENT_STATE_INVALID',
  targetInvalid: 'BLOCKED_TARGET_INVALID',
});

const ACTIVE_ACCOUNT = 'active';
const CONTINUATION_OPERATIONS = new Set(['resume', 'save_response', 'check_item', 'submit']);

export class ReleaseModelError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseModelError';
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function releaseConfigurationSnapshot(state) {
  const sortByHash = (rows) => structuredClone(rows).sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    schema: 'certsim-exam-release-configuration-v1',
    examKey: state.config.examKey,
    catalog: structuredClone(state.config.catalog),
    releaseStage: structuredClone(state.config.releaseStage),
    defaults: sortByHash(state.config.defaults),
    activations: sortByHash(state.config.activations),
    policies: sortByHash(state.config.policies),
  };
}

export function releaseConfigurationHash(state) {
  return canonicalHash(releaseConfigurationSnapshot(state));
}

export function createReleaseSet({
  examKey = 'az400',
  targetPackageVersion = '2.0.0',
  profileKeys = ['full', 'compact', 'sectioned'],
} = {}) {
  return {
    schema: 'certsim-exam-release-set-v1',
    examKey,
    targetPackageVersion,
    profiles: profileKeys.map((profileKey) => ({
      profileKey,
      purposes: RELEASE_PURPOSES.map((purpose) => ({ purpose, targetPackageVersion })),
      practicePolicies: PRACTICE_PURPOSES.map((purpose) => ({
        purpose,
        enabled: true,
        accessMode: 'standard',
        immediateFeedback: purpose !== 'self_directed_exam',
        reviewReleasePolicy: 'after_submit',
        answerReleasePolicy: 'after_submit',
      })),
    })),
  };
}

export function createFixture({ attempts = [], assignments = [], now = '2026-09-20T12:00:00.000Z' } = {}) {
  const profileKeys = ['full', 'compact', 'sectioned'];
  const packageRows = [
    packageFixture('1.0.0', profileKeys),
    packageFixture('2.0.0', profileKeys),
  ];
  return {
    now,
    actor: { id: 'operator-1', role: 'platform_owner', accountStatus: ACTIVE_ACCOUNT },
    packages: packageRows,
    config: {
      examKey: 'az400',
      catalog: { currentVersion: '1.0.0', status: 'active' },
      releaseStage: { state: 'active', packageVersion: '1.0.0' },
      defaults: profileKeys.flatMap((profileKey) => RELEASE_PURPOSES.map((purpose) => ({
        profileKey,
        purpose,
        packageVersion: '1.0.0',
        enabled: true,
      }))),
      activations: packageRows.flatMap((pkg) => profileKeys.map((profileKey) => ({
        packageVersion: pkg.version,
        profileKey,
        enabled: pkg.version === '1.0.0',
      }))),
      policies: packageRows.flatMap((pkg) => profileKeys.flatMap((profileKey) =>
        PRACTICE_PURPOSES.map((purpose) => ({
          packageVersion: pkg.version,
          profileKey,
          purpose,
          enabled: pkg.version === '1.0.0',
          accessMode: 'standard',
          immediateFeedback: purpose !== 'self_directed_exam',
          reviewReleasePolicy: 'after_submit',
          answerReleasePolicy: 'after_submit',
        })))),
    },
    attempts: structuredClone(attempts),
    assignments: structuredClone(assignments),
    results: [{ resultKey: 'aggregate-result-placeholder', score: 72 }],
    reviews: [{ reviewKey: 'aggregate-review-placeholder', released: false }],
    operations: [],
    events: [],
    locks: new Set(),
    nextOperation: 1,
    nextEvent: 1,
  };
}

export function createAttempt({
  id = 'attempt-1',
  packageVersion = '1.0.0',
  profileKey = 'full',
  purpose = 'assigned_assessment',
  ownerId = 'learner-1',
  accountStatus = ACTIVE_ACCOUNT,
  expiresAt = '2026-09-20T13:00:00.000Z',
  practiceIdleExpiresAt = '2026-09-20T13:00:00.000Z',
  frozenSubmission = false,
  continuationContract = true,
  runtime = 'standard',
} = {}) {
  const practice = PRACTICE_PURPOSES.includes(purpose);
  return {
    id,
    packageVersion,
    profileKey,
    purpose,
    ownerId,
    accountStatus,
    status: 'in_progress',
    expiresAt: practice ? null : expiresAt,
    practiceIdleExpiresAt: practice ? practiceIdleExpiresAt : null,
    frozenSubmission,
    runtime,
    continuationContract: continuationContract ? {
      version: 1,
      purpose,
      expiryMode: practice ? 'practice_idle' : 'timed',
      assignmentBindingKind: purpose === 'assigned_assessment' ? 'historical_exact' : 'not_applicable',
      immediateFeedback: practice,
      reviewReleasePolicy: 'after_submit',
      answerReleasePolicy: 'after_submit',
      frozenSubmitAfterExpiry: runtime === 'python',
    } : null,
  };
}

export function createAssignment({
  id = 'assignment-1',
  packageVersion = '1.0.0',
  profileKey = 'full',
  active = true,
  availableFrom = '2026-09-20T11:00:00.000Z',
  expiresAt = '2026-09-20T13:00:00.000Z',
} = {}) {
  return { id, packageVersion, profileKey, active, availableFrom, expiresAt };
}

export function preflightExamRelease(state, releaseSet) {
  const currentFinding = validateCurrentConfiguration(state);
  if (currentFinding) return blockedPreflight(PREFLIGHT_OUTCOMES.currentInvalid, currentFinding);

  const targetFinding = validateTarget(state, releaseSet);
  if (targetFinding) return blockedPreflight(PREFLIGHT_OUTCOMES.targetInvalid, targetFinding);

  const targetVersion = releaseSet.targetPackageVersion;
  const active = state.attempts.filter((attempt) => isGenuinelyActive(attempt, state.now));
  const displaced = active.filter((attempt) => attempt.packageVersion !== targetVersion);
  const unsafe = displaced.filter((attempt) => !validContinuationContract(attempt));
  const counts = {
    activeAttemptsCurrentTarget: active.length - displaced.length,
    activeAttemptsDisplacedPackage: displaced.length,
    activeTimedAttemptsDisplaced: displaced.filter((attempt) =>
      attempt.continuationContract?.expiryMode === 'timed').length,
    activePracticeAttemptsDisplaced: displaced.filter((attempt) =>
      attempt.continuationContract?.expiryMode === 'practice_idle').length,
    activeFrozenSubmissionCount: displaced.filter((attempt) => attempt.frozenSubmission).length,
  };

  if (unsafe.length > 0) {
    return { outcome: PREFLIGHT_OUTCOMES.continuationRisk, findingCodes: ['CONTINUATION_CONTRACT_MISSING'], counts };
  }
  return {
    outcome: displaced.length > 0 ? PREFLIGHT_OUTCOMES.preserved : PREFLIGHT_OUTCOMES.safe,
    findingCodes: [],
    counts,
  };
}

export function stageExamRelease(state, request) {
  return executeOperation(state, 'STAGE', request, (operation) => {
    assertPlatformOwner(state.actor);
    const preflight = preflightExamRelease(state, request.releaseSet);
    transition(state, operation, 'preflighted', { outcome: preflight.outcome });
    if (preflight.outcome.startsWith('BLOCKED_')) {
      return fail(state, operation, preflight.findingCodes[0], preflight);
    }
    if (request.expectedCurrentStateHash !== releaseConfigurationHash(state)) {
      return fail(state, operation, 'RELEASE_STATE_CHANGED', preflight);
    }
    const evidenceFinding = validateEvidence(state, request.releaseSet, request.evidence);
    if (evidenceFinding) return fail(state, operation, evidenceFinding, preflight);

    transition(state, operation, 'executing');
    Object.assign(operation, {
      releaseSet: structuredClone(request.releaseSet),
      evidence: structuredClone(request.evidence),
      stagedCurrentStateHash: request.expectedCurrentStateHash,
      preflight: structuredClone(preflight),
    });
    return succeed(state, operation, {
      outcome: preflight.outcome,
      currentStateHash: request.expectedCurrentStateHash,
      newStartConfigurationChanged: false,
    });
  });
}

export function activateExamRelease(state, request) {
  return executeOperation(state, 'ACTIVATE', request, (operation) => {
    assertPlatformOwner(state.actor);
    const stage = successfulOperation(state, request.stageOperationId, 'STAGE');
    if (!stage) return fail(state, operation, 'STAGE_OPERATION_INVALID');
    if (canonicalHash(stage.releaseSet) !== canonicalHash(request.releaseSet)
      || canonicalHash(stage.evidence) !== canonicalHash(request.evidence)) {
      return fail(state, operation, 'STAGE_EVIDENCE_MISMATCH');
    }
    if (request.expectedCurrentStateHash !== releaseConfigurationHash(state)) {
      return fail(state, operation, 'RELEASE_STATE_CHANGED');
    }
    const preflight = preflightExamRelease(state, request.releaseSet);
    transition(state, operation, 'preflighted', { outcome: preflight.outcome });
    if (preflight.outcome.startsWith('BLOCKED_')) {
      return fail(state, operation, preflight.findingCodes[0], preflight);
    }

    operation.previousStateSnapshot = releaseConfigurationSnapshot(state);
    operation.preflight = structuredClone(preflight);
    transition(state, operation, 'executing');
    const before = structuredClone(state.config);
    try {
      applyReleaseSet(state, request.releaseSet);
      if (request.injectFailure === 'after_defaults') throw new ReleaseModelError('INJECTED_ACTIVATION_FAILURE');
      assertReleaseSetPostconditions(state, request.releaseSet);
      operation.postcondition = {
        currentStateHash: releaseConfigurationHash(state),
        targetVersion: request.releaseSet.targetPackageVersion,
        continuationDisposition: preflight.outcome,
      };
    } catch (error) {
      state.config = before;
      return fail(state, operation, error.code ?? 'ACTIVATION_FAILED', preflight);
    }
    return succeed(state, operation, {
      outcome: preflight.outcome,
      currentStateHash: operation.postcondition.currentStateHash,
    });
  });
}

export function rollbackExamRelease(state, request) {
  return executeOperation(state, 'ROLLBACK', request, (operation) => {
    assertPlatformOwner(state.actor);
    const activation = successfulOperation(state, request.rollbackOfOperationId, 'ACTIVATE');
    if (!activation?.previousStateSnapshot) return fail(state, operation, 'ROLLBACK_TARGET_INVALID');
    if (request.expectedCurrentStateHash !== releaseConfigurationHash(state)) {
      return fail(state, operation, 'RELEASE_STATE_CHANGED');
    }

    const rollbackSet = releaseSetFromSnapshot(activation.previousStateSnapshot);
    const preflight = preflightExamRelease(state, rollbackSet);
    transition(state, operation, 'preflighted', { outcome: preflight.outcome });
    if (preflight.outcome.startsWith('BLOCKED_')) {
      return fail(state, operation, preflight.findingCodes[0], preflight);
    }

    operation.rollbackOfOperationId = activation.id;
    operation.previousStateSnapshot = releaseConfigurationSnapshot(state);
    operation.rollbackTargetSnapshot = structuredClone(activation.previousStateSnapshot);
    operation.preflight = structuredClone(preflight);
    transition(state, operation, 'executing');
    const before = structuredClone(state.config);
    try {
      state.config = configFromSnapshot(activation.previousStateSnapshot);
      if (request.injectFailure === 'after_restore') throw new ReleaseModelError('INJECTED_ROLLBACK_FAILURE');
      assertSnapshotPostconditions(state, activation.previousStateSnapshot);
      operation.postcondition = {
        currentStateHash: releaseConfigurationHash(state),
        targetVersion: state.config.catalog.currentVersion,
        continuationDisposition: preflight.outcome,
      };
    } catch (error) {
      state.config = before;
      return fail(state, operation, error.code ?? 'ROLLBACK_FAILED', preflight);
    }
    return succeed(state, operation, {
      outcome: preflight.outcome,
      currentStateHash: operation.postcondition.currentStateHash,
    });
  });
}

export function resolveNewStart(state, profileKey, purpose) {
  const binding = state.config.defaults.find((row) => row.enabled
    && row.profileKey === profileKey && row.purpose === purpose);
  if (!binding) throw new ReleaseModelError('DEFAULT_BINDING_MISSING');
  const active = state.config.activations.some((row) => row.enabled
    && row.profileKey === profileKey && row.packageVersion === binding.packageVersion);
  if (!active) throw new ReleaseModelError('PRODUCTION_ACTIVATION_MISSING');
  if (PRACTICE_PURPOSES.includes(purpose)) {
    const policy = state.config.policies.find((row) => row.enabled
      && row.profileKey === profileKey && row.purpose === purpose
      && row.packageVersion === binding.packageVersion && row.accessMode !== 'disabled');
    if (!policy) throw new ReleaseModelError('PRACTICE_POLICY_MISSING');
  }
  return { packageVersion: binding.packageVersion, profileKey, purpose };
}

export function resolveAssignedStart(state, assignmentId) {
  const assignment = state.assignments.find((row) => row.id === assignmentId);
  if (!assignment) throw new ReleaseModelError('ASSIGNMENT_NOT_FOUND');
  const now = Date.parse(state.now);
  if (!assignment.active || now < Date.parse(assignment.availableFrom)
    || now >= Date.parse(assignment.expiresAt)) throw new ReleaseModelError('ASSIGNMENT_NOT_AVAILABLE');
  const pkg = state.packages.find((row) => row.version === assignment.packageVersion);
  if (!pkg?.published || !pkg.runtimeSupported || !pkg.profileKeys.includes(assignment.profileKey)) {
    throw new ReleaseModelError('ASSIGNMENT_PACKAGE_INVALID');
  }
  return {
    packageVersion: assignment.packageVersion,
    profileKey: assignment.profileKey,
    purpose: 'assigned_assessment',
    authority: 'historical_exact_assignment',
  };
}

export function authorizeAttemptContinuation(state, attemptId, actorId, requestedOperation) {
  const attempt = state.attempts.find((row) => row.id === attemptId);
  if (!attempt) throw new ReleaseModelError('ATTEMPT_NOT_FOUND');
  if (attempt.ownerId !== actorId) throw new ReleaseModelError('ATTEMPT_OWNER_MISMATCH');
  if (attempt.accountStatus !== ACTIVE_ACCOUNT) throw new ReleaseModelError('ACCOUNT_INACTIVE');
  if (attempt.status !== 'in_progress') throw new ReleaseModelError('ATTEMPT_NOT_CONTINUABLE');
  if (!validContinuationContract(attempt)) throw new ReleaseModelError('CONTINUATION_CONTRACT_MISSING');

  const operation = requestedOperation === 'workspace_save' ? 'save_response'
    : requestedOperation === 'learner_run' ? 'save_response'
      : requestedOperation === 'final_submit' ? 'submit' : requestedOperation;
  if (!CONTINUATION_OPERATIONS.has(operation)) throw new ReleaseModelError('CONTINUATION_OPERATION_INVALID');

  const now = Date.parse(state.now);
  const contract = attempt.continuationContract;
  if (contract.expiryMode === 'practice_idle') {
    if (now >= Date.parse(attempt.practiceIdleExpiresAt)) throw new ReleaseModelError('ATTEMPT_EXPIRED');
  } else if (now >= Date.parse(attempt.expiresAt)) {
    const frozenSubmit = operation === 'submit' && attempt.frozenSubmission
      && contract.frozenSubmitAfterExpiry;
    if (!frozenSubmit) throw new ReleaseModelError('ATTEMPT_EXPIRED');
  }

  return {
    allowed: true,
    packageVersion: attempt.packageVersion,
    profileKey: attempt.profileKey,
    purpose: attempt.purpose,
    operation,
    assignmentBindingKind: contract.assignmentBindingKind,
  };
}

export function listReleaseOperationHistory(state, examKey = state.config.examKey) {
  return state.operations.filter((operation) => operation.examKey === examKey).map((operation) => ({
    id: operation.id,
    requestId: operation.requestId,
    actorId: operation.actorId,
    operationType: operation.operationType,
    state: operation.state,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    errorCode: operation.errorCode ?? null,
    outcome: structuredClone(operation.outcome),
  }));
}

function packageFixture(version, profileKeys) {
  return {
    version,
    valid: true,
    published: true,
    runtimeSupported: true,
    profileKeys,
    packageHash: `package-hash-${version}`,
    validationHash: `validation-hash-${version}`,
    manifestHash: `manifest-hash-${version}`,
    diffHash: `diff-hash-${version}`,
  };
}

function validateCurrentConfiguration(state) {
  const version = state.config.catalog.currentVersion;
  const pkg = state.packages.find((row) => row.version === version);
  if (!pkg?.published) return 'CURRENT_PACKAGE_NOT_PUBLISHED';
  if (state.config.defaults.some((row) => row.enabled && row.packageVersion !== version)) {
    return 'CURRENT_DEFAULTS_AMBIGUOUS';
  }
  for (const binding of state.config.defaults.filter((row) => row.enabled)) {
    const active = state.config.activations.some((row) => row.enabled
      && row.packageVersion === binding.packageVersion && row.profileKey === binding.profileKey);
    if (!active) return 'CURRENT_ACTIVATION_MISSING';
    if (PRACTICE_PURPOSES.includes(binding.purpose)) {
      const policy = state.config.policies.some((row) => row.enabled
        && row.packageVersion === binding.packageVersion && row.profileKey === binding.profileKey
        && row.purpose === binding.purpose && row.accessMode !== 'disabled');
      if (!policy) return 'CURRENT_POLICY_MISSING';
    }
  }
  return null;
}

function validateTarget(state, releaseSet) {
  if (releaseSet?.schema !== 'certsim-exam-release-set-v1'
    || releaseSet.examKey !== state.config.examKey) return 'RELEASE_SET_INVALID';
  const target = state.packages.find((row) => row.version === releaseSet.targetPackageVersion);
  if (!target?.valid) return 'TARGET_PACKAGE_INVALID';
  if (!target.published) return 'TARGET_PACKAGE_NOT_PUBLISHED';
  if (!target.runtimeSupported) return 'TARGET_RUNTIME_INCOMPATIBLE';

  const expectedProfiles = [...new Set(state.config.defaults.filter((row) => row.enabled)
    .map((row) => row.profileKey))].sort();
  const suppliedProfiles = releaseSet.profiles.map((row) => row.profileKey).sort();
  if (canonicalJson(expectedProfiles) !== canonicalJson(suppliedProfiles)
    || new Set(suppliedProfiles).size !== suppliedProfiles.length) return 'RELEASE_SET_PROFILE_MISMATCH';

  for (const profile of releaseSet.profiles) {
    if (!target.profileKeys.includes(profile.profileKey)) return 'TARGET_PROFILE_MISSING';
    const purposes = profile.purposes.map((row) => row.purpose).sort();
    if (new Set(purposes).size !== purposes.length
      || canonicalJson(purposes) !== canonicalJson([...RELEASE_PURPOSES].sort())
      || profile.purposes.some((row) => row.targetPackageVersion !== target.version)) {
      return 'RELEASE_SET_PURPOSE_MISMATCH';
    }
    const policyPurposes = profile.practicePolicies.map((row) => row.purpose).sort();
    if (new Set(policyPurposes).size !== policyPurposes.length
      || canonicalJson(policyPurposes) !== canonicalJson([...PRACTICE_PURPOSES].sort())) {
      return 'RELEASE_SET_POLICY_MISMATCH';
    }
  }
  return null;
}

function validateEvidence(state, releaseSet, evidence) {
  const target = state.packages.find((row) => row.version === releaseSet.targetPackageVersion);
  for (const field of ['packageHash', 'validationHash', 'manifestHash', 'diffHash']) {
    if (!evidence?.[field] || evidence[field] !== target[field]) return 'CANDIDATE_EVIDENCE_MISMATCH';
  }
  return null;
}

function blockedPreflight(outcome, finding) {
  return {
    outcome,
    findingCodes: [finding],
    counts: {
      activeAttemptsCurrentTarget: 0,
      activeAttemptsDisplacedPackage: 0,
      activeTimedAttemptsDisplaced: 0,
      activePracticeAttemptsDisplaced: 0,
      activeFrozenSubmissionCount: 0,
    },
  };
}

function isGenuinelyActive(attempt, nowText) {
  if (attempt.status !== 'in_progress') return false;
  const now = Date.parse(nowText);
  if (attempt.frozenSubmission) return true;
  if (PRACTICE_PURPOSES.includes(attempt.purpose)) {
    return Number.isFinite(Date.parse(attempt.practiceIdleExpiresAt))
      && now < Date.parse(attempt.practiceIdleExpiresAt);
  }
  return Number.isFinite(Date.parse(attempt.expiresAt)) && now < Date.parse(attempt.expiresAt);
}

function validContinuationContract(attempt) {
  const contract = attempt.continuationContract;
  if (!contract || contract.version !== 1 || contract.purpose !== attempt.purpose) return false;
  if (!['timed', 'practice_idle'].includes(contract.expiryMode)) return false;
  return typeof contract.reviewReleasePolicy === 'string'
    && typeof contract.answerReleasePolicy === 'string'
    && typeof contract.immediateFeedback === 'boolean';
}

function applyReleaseSet(state, releaseSet) {
  const targetVersion = releaseSet.targetPackageVersion;
  const movedProfiles = new Set(releaseSet.profiles.map((row) => row.profileKey));
  for (const binding of state.config.defaults) {
    if (movedProfiles.has(binding.profileKey)) binding.packageVersion = targetVersion;
  }
  for (const activation of state.config.activations) {
    if (movedProfiles.has(activation.profileKey)) activation.enabled = activation.packageVersion === targetVersion;
  }
  for (const policy of state.config.policies) {
    if (movedProfiles.has(policy.profileKey)) policy.enabled = false;
  }
  for (const profile of releaseSet.profiles) {
    for (const intended of profile.practicePolicies) {
      const targetPolicy = state.config.policies.find((row) => row.packageVersion === targetVersion
        && row.profileKey === profile.profileKey && row.purpose === intended.purpose);
      if (!targetPolicy) throw new ReleaseModelError('TARGET_POLICY_ROW_MISSING');
      Object.assign(targetPolicy, structuredClone(intended), { packageVersion: targetVersion, profileKey: profile.profileKey });
    }
  }
  state.config.catalog.currentVersion = targetVersion;
  state.config.catalog.status = 'active';
  state.config.releaseStage = { state: 'active', packageVersion: targetVersion };
}

function assertReleaseSetPostconditions(state, releaseSet) {
  const finding = validateCurrentConfiguration(state);
  if (finding) throw new ReleaseModelError(`POSTCONDITION_${finding}`);
  if (state.config.catalog.currentVersion !== releaseSet.targetPackageVersion) {
    throw new ReleaseModelError('POSTCONDITION_CATALOG_MISMATCH');
  }
  const required = releaseSet.profiles.length * RELEASE_PURPOSES.length;
  const targetDefaults = state.config.defaults.filter((row) => row.enabled
    && row.packageVersion === releaseSet.targetPackageVersion).length;
  if (targetDefaults !== required) throw new ReleaseModelError('POSTCONDITION_DEFAULT_COUNT_MISMATCH');
}

function releaseSetFromSnapshot(snapshot) {
  const targetVersion = snapshot.catalog.currentVersion;
  const profileKeys = [...new Set(snapshot.defaults.filter((row) => row.enabled)
    .map((row) => row.profileKey))].sort();
  return createReleaseSet({ examKey: snapshot.examKey, targetPackageVersion: targetVersion, profileKeys });
}

function configFromSnapshot(snapshot) {
  return {
    examKey: snapshot.examKey,
    catalog: structuredClone(snapshot.catalog),
    releaseStage: structuredClone(snapshot.releaseStage),
    defaults: structuredClone(snapshot.defaults),
    activations: structuredClone(snapshot.activations),
    policies: structuredClone(snapshot.policies),
  };
}

function assertSnapshotPostconditions(state, snapshot) {
  if (releaseConfigurationHash(state) !== canonicalHash(snapshot)) {
    throw new ReleaseModelError('POSTCONDITION_ROLLBACK_SNAPSHOT_MISMATCH');
  }
  const finding = validateCurrentConfiguration(state);
  if (finding) throw new ReleaseModelError(`POSTCONDITION_${finding}`);
}

function executeOperation(state, operationType, request, action) {
  const requestHash = canonicalHash(request);
  const existing = state.operations.find((operation) => operation.requestId === request.requestId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new ReleaseModelError('REQUEST_ID_PAYLOAD_CONFLICT');
    return { ...structuredClone(existing.outcome), replayed: true, operationId: existing.id };
  }

  const operation = {
    id: `operation-${state.nextOperation++}`,
    requestId: request.requestId,
    requestHash,
    operationType,
    actorId: state.actor.id,
    examKey: request.releaseSet?.examKey ?? state.config.examKey,
    targetPackageVersion: request.releaseSet?.targetPackageVersion ?? null,
    state: 'requested',
    createdAt: state.now,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    outcome: null,
  };
  state.operations.push(operation);
  appendEvent(state, operation, 'requested');

  if (state.locks.has(operation.examKey)) {
    return fail(state, operation, 'RELEASE_OPERATION_BUSY');
  }
  state.locks.add(operation.examKey);
  operation.startedAt = state.now;
  try {
    return action(operation);
  } catch (error) {
    return fail(state, operation, error.code ?? 'RELEASE_OPERATION_FAILED');
  } finally {
    state.locks.delete(operation.examKey);
  }
}

function transition(state, operation, nextState, details = {}) {
  operation.state = nextState;
  appendEvent(state, operation, nextState, details);
}

function succeed(state, operation, outcome) {
  operation.state = 'succeeded';
  operation.completedAt = state.now;
  operation.outcome = { ok: true, ...structuredClone(outcome) };
  appendEvent(state, operation, 'succeeded', { outcome: outcome.outcome ?? null });
  return { ...structuredClone(operation.outcome), replayed: false, operationId: operation.id };
}

function fail(state, operation, errorCode, preflight = null) {
  operation.state = 'failed';
  operation.completedAt = state.now;
  operation.errorCode = errorCode;
  operation.outcome = { ok: false, errorCode, preflight: structuredClone(preflight) };
  appendEvent(state, operation, 'failed', { errorCode });
  return { ...structuredClone(operation.outcome), replayed: false, operationId: operation.id };
}

function appendEvent(state, operation, eventState, details = {}) {
  state.events.push({
    id: state.nextEvent++,
    operationId: operation.id,
    sequence: state.events.filter((event) => event.operationId === operation.id).length + 1,
    state: eventState,
    occurredAt: state.now,
    details: structuredClone(details),
  });
}

function successfulOperation(state, operationId, operationType) {
  return state.operations.find((operation) => operation.id === operationId
    && operation.operationType === operationType && operation.state === 'succeeded');
}

function assertPlatformOwner(actor) {
  if (actor.role !== 'platform_owner' || actor.accountStatus !== ACTIVE_ACCOUNT) {
    throw new ReleaseModelError('PLATFORM_OWNER_REQUIRED');
  }
}
