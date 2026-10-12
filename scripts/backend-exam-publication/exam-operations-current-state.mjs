import {
  EXECUTABLE_CAPABILITY,
  PBQ_RUNTIME_VERSION,
  PYTHON_EXECUTOR_REQUIREMENT,
} from './exam-operations-capability-registry.mjs';
import { assertSanitizedExamOperationsOutput } from './exam-operations-output-safety.mjs';

export const EXAM_OPERATIONS_CURRENT_STATE_SCHEMA =
  'certsim-exam-operations-current-state-v1';

export const CURRENT_PACKAGE_RESOLUTION = Object.freeze({
  resolved: 'CURRENT_PACKAGE_RESOLVED',
  unresolved: 'CURRENT_PACKAGE_UNRESOLVED',
  ambiguous: 'CURRENT_PACKAGE_AMBIGUOUS',
  invalid: 'CURRENT_PACKAGE_INVALID',
});

const INFORMATIONAL_TYPES = new Set(['case-study-context', 'informational']);
const PRACTICE_PURPOSES = new Set([
  'self_directed_exam',
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
]);

export function buildExamOperationsCurrentState(rawState, requestedExamKey) {
  const examKey = safeExamKey(requestedExamKey ?? rawState?.examKey);
  if (!examKey) throw new Error('EXAMOPS_EXAM_KEY_INVALID');

  const packages = sorted(rawState?.packages, packageSort);
  const profiles = sorted(rawState?.profiles, profileSort);
  const defaults = sorted(
    rawState?.defaults?.filter((entry) => entry?.enabled === true),
    defaultSort,
  );
  const activations = sorted(
    rawState?.activations?.filter((entry) => entry?.enabled === true
      && entry?.activationKind === 'production'),
    activationSort,
  );
  const policies = sorted(rawState?.practicePolicies, policySort);
  const packageByInternalId = new Map(
    packages.map((entry) => [entry.internalPackageId, entry]),
  );
  const profileByInternalId = new Map(
    profiles.map((entry) => [entry.internalProfileId, entry]),
  );
  const resolution = resolveCurrentPackage({
    defaults,
    activations,
    packageByInternalId,
    profileByInternalId,
  });
  const currentPackage = resolution.internalPackageId
    ? packageByInternalId.get(resolution.internalPackageId) ?? null
    : null;
  const currentProfiles = currentPackage
    ? profiles.filter((entry) => entry.internalPackageId === currentPackage.internalPackageId)
    : [];
  const currentQuestions = currentPackage
    ? sorted(
        rawState?.questionRecords?.filter(
          (entry) => entry?.internalPackageId === currentPackage.internalPackageId,
        ),
        questionSort,
      )
    : [];
  const currentForms = currentPackage
    ? rawState?.forms?.filter(
        (entry) => entry?.internalPackageId === currentPackage.internalPackageId,
      ) ?? []
    : [];
  const currentStats = currentPackage
    ? rawState?.packageStats?.find(
        (entry) => entry?.internalPackageId === currentPackage.internalPackageId,
      ) ?? {}
    : {};
  const capabilities = uniqueSorted(
    currentQuestions.map((entry) => safeIdentifier(entry?.interactionType)).filter(Boolean),
  );
  const inventory = summarizeInventory(currentQuestions, currentStats);
  const packageProfiles = currentProfiles.map((profile) => summarizeProfile(
    profile,
    currentForms.filter(
      (entry) => entry?.internalProfileId === profile.internalProfileId,
    ),
    integer(currentStats?.reserveItemCount) ? currentStats.reserveItemCount : 0,
  ));
  const currentDefaults = defaults.map((entry) => ({
    packageVersion: safeVersion(packageByInternalId.get(entry.internalPackageId)?.packageVersion)
      ?? 'unavailable',
    profileKey: safeIdentifier(entry.profileKey) ?? 'invalid',
    purpose: safeIdentifier(entry.purpose) ?? 'invalid',
    enabled: true,
  }));
  const currentActivations = activations
    .filter((entry) => entry.internalPackageId === currentPackage?.internalPackageId)
    .map((entry) => ({
      packageVersion: safeVersion(currentPackage?.packageVersion) ?? 'unavailable',
      profileKey: safeIdentifier(
        profileByInternalId.get(entry.internalProfileId)?.profileKey,
      ) ?? 'invalid',
      activationKind: 'production',
      enabled: true,
    }));
  const currentPolicies = policies
    .filter((entry) => entry.internalPackageId === currentPackage?.internalPackageId)
    .map(sanitizePolicy);
  const predecessor = currentPackage?.supersedesInternalPackageId
    ? packageByInternalId.get(currentPackage.supersedesInternalPackageId) ?? null
    : null;
  const successors = currentPackage
    ? packages
        .filter((entry) => entry.supersedesInternalPackageId === currentPackage.internalPackageId)
        .map((entry) => safeVersion(entry.packageVersion))
        .filter(Boolean)
        .sort(compareText)
    : [];
  const usesPbq = capabilities.some((value) => value.startsWith('pbq-'));
  const usesExecutable = capabilities.includes(EXECUTABLE_CAPABILITY);

  const snapshot = {
    currentStateSchema: EXAM_OPERATIONS_CURRENT_STATE_SCHEMA,
    examKey,
    resolution: {
      status: resolution.status,
      findingCodes: resolution.findingCodes,
      currentPackageVersion: safeVersion(currentPackage?.packageVersion),
      enabledDefaultCount: defaults.length,
      distinctDefaultPackageCount: resolution.distinctPackageCount,
    },
    currentPackage: currentPackage ? {
      packageVersion: safeVersion(currentPackage.packageVersion) ?? 'invalid',
      status: safeIdentifier(currentPackage.status) ?? 'invalid',
      relationship: {
        predecessorPackageVersion: safeVersion(predecessor?.packageVersion),
        successorPackageVersions: successors,
      },
      hashes: {
        sourceHash: null,
        validationHash: safeHash(currentPackage.validationHash),
        packageHash: safeHash(currentPackage.packageHash),
      },
      packageSchemaVersion: safeIdentifier(currentPackage.packageSchemaVersion) ?? 'invalid',
      runtime: {
        generatorVersion: safeIdentifier(currentPackage.generatorVersion) ?? 'invalid',
        scorerVersion: safeIdentifier(currentPackage.scorerVersion) ?? 'invalid',
        pbqRuntimeVersion: usesPbq ? PBQ_RUNTIME_VERSION : null,
        executorRequirement: usesExecutable ? PYTHON_EXECUTOR_REQUIREMENT : null,
        languageRequirements: {
          status: 'NOT_AVAILABLE',
          values: [],
        },
      },
      inventory,
      capabilities,
      profiles: packageProfiles.sort(profileSort),
      releasePolicy: {
        reviewReleasePolicy:
          safeIdentifier(currentPackage.declaredReviewReleasePolicy) ?? null,
        answerReleasePolicy:
          safeIdentifier(currentPackage.declaredAnswerReleasePolicy) ?? null,
      },
      publishedAt: safeTimestamp(currentPackage.publishedAt),
    } : null,
    enabledProductionActivations: currentActivations.sort(activationSort),
    enabledDefaults: currentDefaults.sort(defaultSort),
    practicePolicies: currentPolicies.sort(policySort),
    latestPublication: sanitizePublication(rawState?.latestPublication),
    latestReleaseConfiguration: sanitizeReleaseConfiguration(
      rawState?.latestReleaseConfiguration,
    ),
    dataAvailability: {
      sourceHash: 'NOT_AVAILABLE',
      packageLanguageRequirements: 'NOT_AVAILABLE',
    },
  };
  assertSanitizedExamOperationsOutput(snapshot);

  return Object.freeze({
    snapshot: deepFreeze(snapshot),
    privateComparisonIndex: buildPrivateComparisonIndex(
      rawState,
      resolution.internalPackageId,
    ),
    internal: Object.freeze({
      resolution,
      rawState,
    }),
  });
}

export function buildPrivateComparisonIndex(rawState, internalPackageId) {
  if (!internalPackageId) return null;
  const entries = sorted(
    rawState?.questionRecords?.filter(
      (entry) => entry?.internalPackageId === internalPackageId,
    ),
    questionSort,
  ).map((entry) => ({
    identity: typeof entry.questionIdentity === 'string' ? entry.questionIdentity : null,
    contentHash: safeHash(entry.contentHash),
  }));
  if (entries.some((entry) => !entry.identity || !entry.contentHash)) return null;
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function resolveCurrentPackage({
  defaults,
  activations,
  packageByInternalId,
  profileByInternalId,
}) {
  const packageIds = uniqueSorted(defaults.map((entry) => entry.internalPackageId));
  if (packageIds.length === 0) {
    return resolution(CURRENT_PACKAGE_RESOLUTION.unresolved, null, 0);
  }
  if (packageIds.length > 1) {
    return resolution(CURRENT_PACKAGE_RESOLUTION.ambiguous, null, packageIds.length);
  }

  const internalPackageId = packageIds[0];
  const boundPackage = packageByInternalId.get(internalPackageId);
  const invalidBinding = defaults.some((entry) => {
    const profile = profileByInternalId.get(entry.internalProfileId);
    return !boundPackage || !profile
      || profile.internalPackageId !== entry.internalPackageId
      || profile.profileKey !== entry.profileKey;
  });
  const activationMissing = defaults.some((entry) => !activations.some(
    (activation) => activation.internalPackageId === entry.internalPackageId
      && activation.internalProfileId === entry.internalProfileId,
  ));
  const findings = [];
  if (invalidBinding) findings.push('DEFAULT_BINDING_INVALID');
  if (boundPackage?.status !== 'published') findings.push('CURRENT_PACKAGE_NOT_PUBLISHED');
  if (activationMissing) findings.push('CURRENT_ACTIVATION_MISSING');
  if (findings.length > 0) {
    return resolution(
      CURRENT_PACKAGE_RESOLUTION.invalid,
      internalPackageId,
      1,
      findings,
    );
  }
  return resolution(
    CURRENT_PACKAGE_RESOLUTION.resolved,
    internalPackageId,
    1,
  );
}

function resolution(status, internalPackageId, distinctPackageCount, extraFindings = []) {
  return Object.freeze({
    status,
    internalPackageId,
    distinctPackageCount,
    findingCodes: uniqueSorted([
      ...(status === CURRENT_PACKAGE_RESOLUTION.resolved ? [] : [status]),
      ...extraFindings,
    ]),
  });
}

function summarizeInventory(questions, stats) {
  const byInteractionType = new Map();
  const byDomain = new Map();
  const byObjective = new Map();
  let scoredItemCount = 0;
  let informationalItemCount = 0;
  let contextItemCount = 0;
  let pbqItemCount = 0;
  let executableLabItemCount = 0;
  let scoredCaseItemCount = 0;

  for (const question of questions) {
    const interaction = safeIdentifier(question.interactionType) ?? 'invalid';
    const domain = safeIdentifier(question.domainKey) ?? 'unspecified';
    const objective = safeIdentifier(question.objectiveKey);
    increment(byInteractionType, interaction);
    increment(byDomain, domain);
    if (objective) increment(byObjective, objective);
    if (question.scored === true) scoredItemCount += 1;
    if (INFORMATIONAL_TYPES.has(interaction)) informationalItemCount += 1;
    if (interaction === 'case-study-context') contextItemCount += 1;
    if (interaction.startsWith('pbq-')) pbqItemCount += 1;
    if (interaction === EXECUTABLE_CAPABILITY) executableLabItemCount += 1;
    if (question.caseRole === 'question' && question.scored === true) {
      scoredCaseItemCount += 1;
    }
  }

  return {
    totalItemCount: questions.length,
    scoredItemCount,
    informationalItemCount,
    contextItemCount,
    caseStudyGroupCount: integer(stats?.caseStudyGroupCount)
      ? stats.caseStudyGroupCount
      : 0,
    scoredCaseItemCount,
    pbqItemCount,
    executableLabItemCount,
    byInteractionType: countEntries(byInteractionType),
    byDomain: countEntries(byDomain),
    byObjective: countEntries(byObjective),
  };
}

function summarizeProfile(profile, forms, reserveItemCount) {
  const questionCount = nonnegativeInteger(profile.questionCount);
  const caseStudyCount = firstInteger(
    profile.caseStudyCount,
    sumOptional(profile.longCaseStudyCount, profile.shortCaseStudyCount),
    0,
  );
  const pbqCount = firstInteger(profile.pbqCount, 0);
  const executableCount = firstInteger(profile.executableCount, 0);
  const mixed = caseStudyCount > 0 || pbqCount > 0 || executableCount > 0;
  const explicitStandard = firstInteger(
    profile.standardQuestionCount,
    profile.normalScoredQuestionCount,
  );
  const standardQuestionCount = explicitStandard ?? (mixed ? null : questionCount);
  const caseStudyQuestionCount = firstInteger(
    profile.caseStudyQuestionCount,
    caseStudyCount === 0 ? 0 : null,
  );
  const total = [
    standardQuestionCount,
    caseStudyQuestionCount,
    pbqCount,
    executableCount,
  ].every(integer)
    ? standardQuestionCount + caseStudyQuestionCount + pbqCount + executableCount
    : null;
  const sortedForms = sorted(forms, (left, right) => (
    Number(left?.formOrdinal ?? 0) - Number(right?.formOrdinal ?? 0)
      || compareText(left?.membershipHash ?? '', right?.membershipHash ?? '')
  ));
  const fixed = sortedForms.length > 0 || Boolean(profile.formContractVersion);
  const formItemCount = sortedForms.length > 0
    ? nonnegativeInteger(sortedForms[0].itemCount)
    : 0;
  const formScoredCount = sortedForms.length > 0
    ? nonnegativeInteger(sortedForms[0].scoredItemCount)
    : 0;

  return {
    profileKey: safeIdentifier(profile.profileKey) ?? 'invalid',
    displayName: safeDisplay(profile.displayName),
    questionCount,
    scoredQuestionCount: questionCount,
    deliveredItemCount: questionCount + caseStudyCount,
    timeLimitMinutes: nonnegativeInteger(profile.timeLimitMinutes),
    selectionClassification: fixed ? 'fixed' : 'dynamic',
    composition: {
      standardQuestionCount,
      caseStudyCount,
      caseStudyQuestionCount,
      pbqCount,
      executableCount,
      state: total === questionCount ? 'valid' : 'invalid',
    },
    sectionOrder: sanitizeSectionOrder(profile.sectionOrder),
    forms: {
      contractVersion: fixed
        ? safeIdentifier(profile.formContractVersion)
        : null,
      formCount: sortedForms.length,
      itemCount: formItemCount,
      scoredItemCount: formScoredCount,
      membershipHashes: sortedForms
        .map((entry) => safeHash(entry.membershipHash))
        .filter(Boolean),
      reserveItemCount: fixed ? reserveItemCount : 0,
    },
  };
}

function sanitizePolicy(entry) {
  return {
    packageVersion: safeVersion(entry?.packageVersion) ?? 'unavailable',
    profileKey: safeIdentifier(entry?.profileKey) ?? 'invalid',
    purpose: safeIdentifier(entry?.purpose) ?? 'invalid',
    enabled: entry?.enabled === true,
    accessMode: safeIdentifier(entry?.accessMode) ?? 'invalid',
    maximumSessionItems: nullableInteger(entry?.maximumSessionItems),
    immediateFeedback: entry?.immediateFeedback === true,
    reviewReleasePolicy: safeIdentifier(entry?.reviewReleasePolicy) ?? 'invalid',
    answerReleasePolicy: safeIdentifier(entry?.answerReleasePolicy) ?? 'invalid',
  };
}

function sanitizePublication(value) {
  if (!value) return null;
  return {
    packageVersion: safeVersion(value.packageVersion),
    status: safeIdentifier(value.status) ?? 'invalid',
    errorCode: safeIdentifier(value.errorCode),
    createdAt: safeTimestamp(value.createdAt),
    completedAt: safeTimestamp(value.completedAt),
  };
}

function sanitizeReleaseConfiguration(value) {
  if (!value) return null;
  return {
    packageVersion: safeVersion(value.packageVersion),
    profileKey: safeIdentifier(value.profileKey),
    releaseStage: safeIdentifier(value.releaseStage) ?? 'invalid',
    configuredAt: safeTimestamp(value.configuredAt),
    source: safeIdentifier(value.source),
    operationType: safeIdentifier(value.operationType),
    resultState: safeIdentifier(value.resultState),
  };
}

function sanitizeSectionOrder(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('-')
      : [];
  return values
    .map((entry) => normalizeSection(entry))
    .filter(Boolean);
}

function normalizeSection(value) {
  if (value === 'standard') return 'standard';
  if (['case', 'caseStudy', 'case-study'].includes(value)) return 'case';
  if (value === 'pbq') return 'pbq';
  if (['executable', 'lab'].includes(value)) return 'executable';
  return null;
}

function countEntries(map) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => compareText(left.key, right.key));
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sorted(value, compare) {
  return [...(Array.isArray(value) ? value : [])].sort(compare);
}

function packageSort(left, right) {
  return compareText(left?.packageVersion ?? '', right?.packageVersion ?? '');
}

function profileSort(left, right) {
  return compareText(left?.profileKey ?? '', right?.profileKey ?? '');
}

function questionSort(left, right) {
  return compareText(left?.questionIdentity ?? '', right?.questionIdentity ?? '');
}

function defaultSort(left, right) {
  return compareText(left?.profileKey ?? '', right?.profileKey ?? '')
    || compareText(left?.purpose ?? '', right?.purpose ?? '')
    || compareText(left?.packageVersion ?? '', right?.packageVersion ?? '');
}

function activationSort(left, right) {
  return compareText(left?.profileKey ?? '', right?.profileKey ?? '')
    || compareText(left?.activationKind ?? '', right?.activationKind ?? '');
}

function policySort(left, right) {
  return compareText(left?.profileKey ?? '', right?.profileKey ?? '')
    || compareText(left?.purpose ?? '', right?.purpose ?? '')
    || compareText(left?.packageVersion ?? '', right?.packageVersion ?? '');
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))]
    .sort(compareText);
}

function safeExamKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z0-9]+$/.test(normalized) ? normalized : null;
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : null;
}

function safeVersion(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(value)
    ? value
    : null;
}

function safeHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeDisplay(value) {
  if (typeof value !== 'string') return 'unavailable';
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized && normalized.length <= 120 ? normalized : 'unavailable';
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonnegativeInteger(value) {
  return integer(value) ? value : 0;
}

function nullableInteger(value) {
  return value === null || value === undefined ? null : nonnegativeInteger(value);
}

function firstInteger(...values) {
  return values.find((value) => integer(value)) ?? null;
}

function sumOptional(left, right) {
  return integer(left) || integer(right)
    ? nonnegativeInteger(left) + nonnegativeInteger(right)
    : null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function isPracticePurpose(purpose) {
  return PRACTICE_PURPOSES.has(purpose);
}
