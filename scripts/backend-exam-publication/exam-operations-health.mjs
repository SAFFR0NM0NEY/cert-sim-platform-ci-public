import {
  PLATFORM_CAPABILITY_CHANGE_REQUIRED,
  classifyRuntimeCompatibility,
} from './exam-operations-capability-registry.mjs';
import {
  CURRENT_PACKAGE_RESOLUTION,
} from './exam-operations-current-state.mjs';
import { assertSanitizedExamOperationsOutput } from './exam-operations-output-safety.mjs';

export const EXAM_OPERATIONS_HEALTH_SCHEMA =
  'certsim-exam-operations-health-v1';

export const HEALTH_STATES = Object.freeze({
  pass: 'PASS',
  warning: 'WARNING',
  blocked: 'BLOCKED',
  unavailable: 'NOT_AVAILABLE',
});

const TIMED_PURPOSES = new Set(['assigned_assessment', 'self_directed_exam']);
const UNTIMED_PRACTICE_PURPOSES = new Set([
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
]);
const UNAVAILABLE_TELEMETRY_CHECKS = new Set([
  'SAVE_FAILURE_TELEMETRY',
  'SUBMIT_FAILURE_TELEMETRY',
  'DEPLOYMENT_CORRELATION',
  'POST_RELEASE_HEALTH_EVENT',
]);

export function createExamOperationsHealth(currentStateBuild) {
  const snapshot = currentStateBuild?.snapshot;
  const raw = currentStateBuild?.internal?.rawState ?? {};
  if (!snapshot) throw new Error('EXAMOPS_CURRENT_STATE_REQUIRED');

  const currentVersion = snapshot.currentPackage?.packageVersion ?? null;
  const attemptRows = normalizeAttemptRows(raw.attemptAggregates);
  const activeAttemptsCurrentPackage = attemptRows
    .filter((entry) => entry.packageVersion === currentVersion)
    .reduce(sumCount, 0);
  const activeAttemptsOlderPackage = attemptRows
    .filter((entry) => entry.packageVersion !== currentVersion)
    .reduce(sumCount, 0);
  const activeTimedAttempts = attemptRows
    .filter((entry) => TIMED_PURPOSES.has(entry.purpose))
    .reduce(sumCount, 0);
  const activePracticeAttempts = attemptRows
    .filter((entry) => UNTIMED_PRACTICE_PURPOSES.has(entry.purpose))
    .reduce(sumCount, 0);
  const attemptsKnown = attemptRows.every((entry) => (
    TIMED_PURPOSES.has(entry.purpose) || UNTIMED_PRACTICE_PURPOSES.has(entry.purpose)
  ));
  const activationAssessment = assessActivations(snapshot);
  const practiceAssessment = assessPracticePolicies(snapshot);
  const runtimeCompatibility = snapshot.currentPackage
    ? classifyRuntimeCompatibility(
        snapshot.currentPackage.runtime,
        snapshot.currentPackage.capabilities,
      )
    : null;
  const continuation = assessContinuation(
    attemptRows,
    currentVersion,
    raw.activations,
    raw.practicePolicies,
  );
  const checks = [
    check(
      'CURRENT_PACKAGE_RESOLVED',
      snapshot.resolution.status === CURRENT_PACKAGE_RESOLUTION.resolved
        ? HEALTH_STATES.pass
        : HEALTH_STATES.blocked,
      snapshot.resolution.findingCodes,
    ),
    check(
      'PACKAGE_PUBLISHED',
      snapshot.currentPackage?.status === 'published'
        ? HEALTH_STATES.pass
        : HEALTH_STATES.blocked,
      snapshot.currentPackage?.status === 'published' ? [] : ['CURRENT_PACKAGE_NOT_PUBLISHED'],
    ),
    check(
      'DEFAULT_BINDINGS_VALID',
      snapshot.resolution.findingCodes.includes('DEFAULT_BINDING_INVALID')
        || snapshot.enabledDefaults.length === 0
        ? HEALTH_STATES.blocked
        : HEALTH_STATES.pass,
      snapshot.enabledDefaults.length === 0
        ? ['CURRENT_PACKAGE_UNRESOLVED']
        : snapshot.resolution.findingCodes.filter((code) => code === 'DEFAULT_BINDING_INVALID'),
    ),
    check('ACTIVATIONS_VALID', activationAssessment.state, activationAssessment.findings),
    check('PRACTICE_POLICIES_VALID', practiceAssessment.state, practiceAssessment.findings),
    check(
      'RUNTIME_SUPPORTED',
      runtimeCompatibility?.verdict === PLATFORM_CAPABILITY_CHANGE_REQUIRED
        || !runtimeCompatibility
        ? HEALTH_STATES.blocked
        : HEALTH_STATES.pass,
      runtimeCompatibility?.reasons ?? ['CURRENT_RUNTIME_UNAVAILABLE'],
    ),
    publicationCheck(snapshot.latestPublication),
    releaseRequestCheck(snapshot.latestReleaseConfiguration),
    check(
      'ACTIVE_ATTEMPTS_ACCOUNTED',
      attemptsKnown ? HEALTH_STATES.pass : HEALTH_STATES.warning,
      attemptsKnown ? [] : ['ACTIVE_ATTEMPT_PURPOSE_UNKNOWN'],
    ),
    check(
      'PREDECESSOR_CONTINUATION',
      continuation.state === 'PREDECESSOR_CONTINUATION_DEPENDENCY_PRESENT'
        || continuation.state === 'UNABLE_TO_DETERMINE'
        ? HEALTH_STATES.warning
        : HEALTH_STATES.pass,
      continuation.findings,
    ),
    unavailableCheck('SAVE_FAILURE_TELEMETRY'),
    unavailableCheck('SUBMIT_FAILURE_TELEMETRY'),
    unavailableCheck('DEPLOYMENT_CORRELATION'),
    unavailableCheck('POST_RELEASE_HEALTH_EVENT'),
  ];
  const overallHealth = checks.some((entry) => entry.state === HEALTH_STATES.blocked)
    ? 'BLOCKED'
    : checks.some((entry) => entry.state === HEALTH_STATES.warning
        || entry.state === HEALTH_STATES.unavailable)
      ? 'WARNING'
      : 'HEALTHY';
  const report = {
    healthSchema: EXAM_OPERATIONS_HEALTH_SCHEMA,
    examKey: snapshot.examKey,
    observedAt: safeTimestamp(raw.observedAt),
    overallHealth,
    currentPackage: snapshot.currentPackage ? {
      packageVersion: snapshot.currentPackage.packageVersion,
      status: snapshot.currentPackage.status,
      hashes: snapshot.currentPackage.hashes,
      packageSchemaVersion: snapshot.currentPackage.packageSchemaVersion,
    } : null,
    enabledProductionProfiles: snapshot.enabledProductionActivations.map(
      (entry) => entry.profileKey,
    ).sort(compareText),
    defaultBindings: snapshot.enabledDefaults,
    practicePolicies: snapshot.practicePolicies,
    runtime: snapshot.currentPackage?.runtime ?? null,
    latestPublication: snapshot.latestPublication,
    latestReleaseConfiguration: snapshot.latestReleaseConfiguration,
    activeAttemptAggregates: {
      activeAttemptsTotal: attemptRows.reduce(sumCount, 0),
      activeAttemptsCurrentPackage,
      activeAttemptsOlderPackage,
      activeTimedAttempts,
      activePracticeAttempts,
    },
    predecessorContinuation: continuation,
    checks,
    unavailableTelemetryFields: checks
      .filter((entry) => entry.state === HEALTH_STATES.unavailable
        && UNAVAILABLE_TELEMETRY_CHECKS.has(entry.code))
      .map((entry) => entry.code),
  };
  assertSanitizedExamOperationsOutput(report);
  return deepFreeze(report);
}

export function formatExamOperationsHealthReport(health) {
  const attempts = health.activeAttemptAggregates;
  return [
    `Exam: ${health.examKey}`,
    `Overall health: ${health.overallHealth}`,
    `Current package: ${health.currentPackage?.packageVersion ?? 'unresolved'} (${health.currentPackage?.status ?? 'unavailable'})`,
    `Production profiles: ${health.enabledProductionProfiles.join(', ') || 'none'}`,
    `Defaults: ${health.defaultBindings.length}`,
    `Practice policies: ${health.practicePolicies.length}`,
    `Runtime: ${health.runtime?.generatorVersion ?? 'unavailable'} / ${health.runtime?.scorerVersion ?? 'unavailable'}`,
    `Latest publication: ${health.latestPublication?.status ?? 'NOT_AVAILABLE'}`,
    `Latest release request: ${health.latestReleaseConfiguration?.releaseStage ?? 'NOT_AVAILABLE'}`,
    `Active attempts: ${attempts.activeAttemptsTotal} total; ${attempts.activeAttemptsCurrentPackage} current; ${attempts.activeAttemptsOlderPackage} older; ${attempts.activeTimedAttempts} timed; ${attempts.activePracticeAttempts} practice`,
    `Predecessor continuation: ${health.predecessorContinuation.state}`,
    `Unavailable telemetry: ${health.unavailableTelemetryFields.join(', ')}`,
    `Checks: ${health.checks.map((entry) => `${entry.code}:${entry.state}`).join(', ')}`,
  ].join('\n');
}

function assessActivations(snapshot) {
  if (!snapshot.currentPackage) {
    return { state: HEALTH_STATES.blocked, findings: ['CURRENT_ACTIVATION_UNRESOLVED'] };
  }
  const missing = snapshot.enabledDefaults.filter((binding) => !snapshot
    .enabledProductionActivations.some((activation) => (
      activation.packageVersion === binding.packageVersion
        && activation.profileKey === binding.profileKey
    )));
  return missing.length > 0
    ? { state: HEALTH_STATES.blocked, findings: ['CURRENT_ACTIVATION_MISSING'] }
    : { state: HEALTH_STATES.pass, findings: [] };
}

function assessPracticePolicies(snapshot) {
  const expected = snapshot.enabledDefaults.filter(
    (entry) => entry.purpose !== 'assigned_assessment',
  );
  const missing = expected.filter((binding) => !snapshot.practicePolicies.some(
    (policy) => policy.packageVersion === binding.packageVersion
      && policy.profileKey === binding.profileKey
      && policy.purpose === binding.purpose
      && policy.enabled
      && policy.accessMode !== 'disabled',
  ));
  return missing.length > 0
    ? { state: HEALTH_STATES.blocked, findings: ['PRACTICE_POLICY_MISSING_OR_DISABLED'] }
    : { state: HEALTH_STATES.pass, findings: [] };
}

function assessContinuation(attemptRows, currentVersion, activations, policies) {
  if (!currentVersion) {
    return {
      state: 'UNABLE_TO_DETERMINE',
      olderActiveAttemptCount: attemptRows.reduce(sumCount, 0),
      olderActivePracticeAttemptCount: 0,
      dependencyBindingIssueCount: 0,
      findings: ['CURRENT_PACKAGE_UNRESOLVED'],
    };
  }
  const older = attemptRows.filter((entry) => entry.packageVersion !== currentVersion);
  const olderPractice = older.filter((entry) => UNTIMED_PRACTICE_PURPOSES.has(entry.purpose));
  if (older.length === 0) {
    return {
      state: 'NO_ACTIVE_PREDECESSOR_ATTEMPTS',
      olderActiveAttemptCount: 0,
      olderActivePracticeAttemptCount: 0,
      dependencyBindingIssueCount: 0,
      findings: [],
    };
  }
  if (olderPractice.length === 0) {
    return {
      state: 'CONTINUATION_SAFE_AS_CONFIGURED',
      olderActiveAttemptCount: older.reduce(sumCount, 0),
      olderActivePracticeAttemptCount: 0,
      dependencyBindingIssueCount: 0,
      findings: [],
    };
  }
  let dependencyBindingIssueCount = 0;
  for (const attempt of olderPractice) {
    const activation = (activations ?? []).some((entry) => entry.enabled === true
      && entry.activationKind === 'production'
      && entry.packageVersion === attempt.packageVersion
      && entry.profileKey === attempt.profileKey);
    const policy = (policies ?? []).some((entry) => entry.enabled === true
      && entry.accessMode !== 'disabled'
      && entry.packageVersion === attempt.packageVersion
      && entry.profileKey === attempt.profileKey
      && entry.purpose === attempt.purpose);
    if (!activation || !policy) dependencyBindingIssueCount += attempt.activeCount;
  }
  return {
    state: 'PREDECESSOR_CONTINUATION_DEPENDENCY_PRESENT',
    olderActiveAttemptCount: older.reduce(sumCount, 0),
    olderActivePracticeAttemptCount: olderPractice.reduce(sumCount, 0),
    dependencyBindingIssueCount,
    findings: ['PREDECESSOR_CONTINUATION_DEPENDENCY_PRESENT'],
  };
}

function publicationCheck(publication) {
  if (!publication) return unavailableCheck('LATEST_PUBLICATION_SUCCEEDED');
  return check(
    'LATEST_PUBLICATION_SUCCEEDED',
    publication.status === 'succeeded' ? HEALTH_STATES.pass : HEALTH_STATES.warning,
    publication.status === 'succeeded'
      ? []
      : [publication.errorCode ?? 'LATEST_PUBLICATION_NOT_SUCCEEDED'],
  );
}

function releaseRequestCheck(request) {
  return request
    ? check('LATEST_RELEASE_REQUEST_RECORDED', HEALTH_STATES.pass, [])
    : check(
        'LATEST_RELEASE_REQUEST_RECORDED',
        HEALTH_STATES.unavailable,
        ['RELEASE_REQUEST_NOT_AVAILABLE'],
      );
}

function unavailableCheck(code) {
  return check(code, HEALTH_STATES.unavailable, ['TELEMETRY_NOT_AVAILABLE']);
}

function check(code, state, findings) {
  return {
    code,
    state,
    findings: uniqueSorted(findings),
  };
}

function normalizeAttemptRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .map((entry) => ({
      packageVersion: typeof entry?.packageVersion === 'string'
        ? entry.packageVersion
        : 'unavailable',
      profileKey: typeof entry?.profileKey === 'string'
        ? entry.profileKey
        : 'unavailable',
      purpose: typeof entry?.purpose === 'string' ? entry.purpose : 'unknown',
      activeCount: Number.isSafeInteger(entry?.activeCount) && entry.activeCount >= 0
        ? entry.activeCount
        : 0,
    }))
    .sort((left, right) => compareText(left.packageVersion, right.packageVersion)
      || compareText(left.profileKey, right.profileKey)
      || compareText(left.purpose, right.purpose));
}

function sumCount(sum, entry) {
  return sum + entry.activeCount;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value))]
    .sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
