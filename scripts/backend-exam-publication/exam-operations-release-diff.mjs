import {
  canonicalSerialize,
  sha256Canonical,
} from './canonical-json.mjs';
import {
  MIGRATION_CLASSIFICATIONS,
} from './exam-operations-candidate.mjs';
import {
  PLATFORM_CAPABILITY_CHANGE_REQUIRED,
  SUPPORTED_EXISTING_PLATFORM_CAPABILITY,
  classifyCapabilityCompatibility,
  classifyRuntimeCompatibility,
} from './exam-operations-capability-registry.mjs';
import {
  CURRENT_PACKAGE_RESOLUTION,
} from './exam-operations-current-state.mjs';
import { assertSanitizedExamOperationsOutput } from './exam-operations-output-safety.mjs';

export const EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA =
  'certsim-exam-operations-release-diff-v1';

export const RELEASE_CHANGE_CLASSIFICATIONS = Object.freeze({
  noChange: 'NO_CHANGE',
  content: 'CONTENT_CHANGE',
  profile: 'PROFILE_CHANGE',
  form: 'FORM_CHANGE',
  runtime: 'RUNTIME_CHANGE',
  capability: 'CAPABILITY_CHANGE',
  mixed: 'MIXED_CHANGE',
  invalid: 'INVALID_CANDIDATE',
  currentUnavailable: 'CURRENT_STATE_UNAVAILABLE',
  legacy: 'LEGACY_PACKAGE_PATH',
});

const INVENTORY_FIELDS = [
  'totalItemCount',
  'scoredItemCount',
  'informationalItemCount',
  'contextItemCount',
  'caseStudyGroupCount',
  'scoredCaseItemCount',
  'pbqItemCount',
  'executableLabItemCount',
];

const PROFILE_FIELDS = [
  ['displayName', (profile) => profile?.displayName ?? null],
  ['questionCount', (profile) => numberOrNull(profile?.questionCount)],
  ['scoredQuestionCount', (profile) => numberOrNull(profile?.scoredQuestionCount)],
  ['timeLimitMinutes', (profile) => numberOrNull(profile?.timeLimitMinutes)],
  ['standardQuestionCount', (profile) => numberOrNull(profile?.composition?.standardQuestionCount)],
  ['caseStudyCount', (profile) => numberOrNull(profile?.composition?.caseStudyCount)],
  ['scoredCaseQuestionCount', (profile) => numberOrNull(profile?.composition?.caseStudyQuestionCount)],
  ['pbqCount', (profile) => numberOrNull(profile?.composition?.pbqCount)],
  ['executableCount', (profile) => numberOrNull(profile?.composition?.executableCount)],
  ['sectionOrder', (profile) => [...(profile?.sectionOrder ?? [])]],
  ['selectionClassification', (profile) => profile?.selectionClassification ?? null],
  ['formCount', (profile) => numberOrNull(profile?.forms?.formCount)],
];

export function createCandidateQuestionFingerprintIndex(contract) {
  const questions = Array.isArray(contract?.questions) ? contract.questions : [];
  return Object.freeze(questions.map((question) => Object.freeze({
    identity: typeof question?.id === 'string' ? question.id : null,
    contentHash: question && typeof question === 'object'
      ? safeQuestionHash(question)
      : null,
  })));
}

export function createExamOperationsReleaseDiff({
  currentState,
  candidateValidation,
  currentFingerprintIndex,
  candidateContract,
}) {
  if (candidateValidation?.migrationClassification === MIGRATION_CLASSIFICATIONS.legacy) {
    return legacyDiff(candidateValidation);
  }

  const manifest = candidateValidation?.manifest;
  if (!manifest) throw new Error('EXAMOPS_CANDIDATE_MANIFEST_REQUIRED');
  const currentResolution = currentState?.resolution?.status;
  if (currentResolution !== CURRENT_PACKAGE_RESOLUTION.resolved
      || !currentState?.currentPackage) {
    const blocked = {
      releaseDiffSchema: EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA,
      examKey: manifest.candidate.examKey,
      currentPackageVersion: currentState?.resolution?.currentPackageVersion ?? null,
      candidatePackageVersion: manifest.candidate.packageVersion,
      overallChangeClassification: RELEASE_CHANGE_CLASSIFICATIONS.currentUnavailable,
      changeDimensions: [],
      migrationClassification: candidateValidation.migrationClassification,
      findings: uniqueSorted([
        ...(currentState?.resolution?.findingCodes ?? []),
        'CURRENT_STATE_COMPARISON_BLOCKED',
      ]),
      cutoverPreflightRequired: true,
    };
    assertSanitizedExamOperationsOutput(blocked);
    return deepFreeze(blocked);
  }

  const current = currentState.currentPackage;
  const candidateIndex = createCandidateQuestionFingerprintIndex(candidateContract);
  const questionInventory = compareQuestionInventories(
    currentFingerprintIndex,
    candidateIndex,
  );
  const duplicateReport = createDuplicateReport(
    currentFingerprintIndex,
    candidateIndex,
    questionInventory,
  );
  const aggregateInventory = compareInventory(current.inventory, manifest.inventory);
  const capabilityDiff = compareSets(current.capabilities, manifest.capabilities);
  const unsupportedAdded = classifyCapabilityCompatibility(capabilityDiff.added).unsupported;
  const runtimeDiff = compareRuntime(current, manifest);
  const profileDiff = compareProfiles(current.profiles, manifest.profiles);
  const formDiff = compareForms(current.profiles, manifest.profiles);
  const releasePolicyDiff = compareObjectFields(
    current.releasePolicy,
    manifest.releasePolicy,
    ['reviewReleasePolicy', 'answerReleasePolicy'],
  );
  const invalid = candidateValidation.validation?.verdict === 'invalid';
  const contentChanged = questionInventory.status === 'AVAILABLE'
    ? ['addedCount', 'removedCount', 'changedCount']
        .some((key) => questionInventory[key] > 0)
    : aggregateInventory.changed;
  const profileChanged = profileDiff.changed || releasePolicyDiff.changed;
  const formChanged = formDiff.changed;
  const runtimeChanged = runtimeDiff.changed;
  const capabilityChanged = unsupportedAdded.length > 0;
  const dimensions = [
    ...(contentChanged ? [RELEASE_CHANGE_CLASSIFICATIONS.content] : []),
    ...(profileChanged ? [RELEASE_CHANGE_CLASSIFICATIONS.profile] : []),
    ...(formChanged ? [RELEASE_CHANGE_CLASSIFICATIONS.form] : []),
    ...(runtimeChanged ? [RELEASE_CHANGE_CLASSIFICATIONS.runtime] : []),
    ...(capabilityChanged ? [RELEASE_CHANGE_CLASSIFICATIONS.capability] : []),
  ];
  const overallChangeClassification = invalid
    ? RELEASE_CHANGE_CLASSIFICATIONS.invalid
    : dimensions.length === 0
      ? RELEASE_CHANGE_CLASSIFICATIONS.noChange
      : dimensions.length === 1
        ? dimensions[0]
        : RELEASE_CHANGE_CLASSIFICATIONS.mixed;
  const findings = uniqueSorted([
    ...duplicateReport.findingCodes,
    ...(questionInventory.status === 'AVAILABLE'
      ? []
      : ['QUESTION_IDENTITY_COMPARISON_UNAVAILABLE']),
    ...(unsupportedAdded.length > 0
      ? [MIGRATION_CLASSIFICATIONS.capabilityChange]
      : []),
    ...(invalid ? [MIGRATION_CLASSIFICATIONS.invalid] : []),
  ]);

  const result = {
    releaseDiffSchema: EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA,
    examKey: manifest.candidate.examKey,
    currentPackageVersion: current.packageVersion,
    candidatePackageVersion: manifest.candidate.packageVersion,
    overallChangeClassification,
    changeDimensions: dimensions,
    migrationClassification: candidateValidation.migrationClassification,
    questionInventory,
    aggregateInventory,
    capabilities: {
      addedCapabilities: capabilityDiff.added,
      removedCapabilities: capabilityDiff.removed,
      unchangedCapabilities: capabilityDiff.unchanged,
      unsupportedAddedCapabilityCount: unsupportedAdded.length,
    },
    runtime: runtimeDiff.report,
    profiles: profileDiff.report,
    forms: formDiff.report,
    releasePolicy: releasePolicyDiff,
    exactHashReport: duplicateReport,
    compatibility: candidateValidation.compatibility,
    findings,
    cutoverPreflightRequired: true,
  };
  assertSanitizedExamOperationsOutput(result);
  return deepFreeze(result);
}

export function formatExamOperationsReleaseDiffReport(diff) {
  if (diff.overallChangeClassification === RELEASE_CHANGE_CLASSIFICATIONS.legacy) {
    return [
      `Exam: ${diff.examKey}`,
      `Current version: ${diff.currentPackageVersion ?? 'not compared'}`,
      `Candidate version: ${diff.candidatePackageVersion}`,
      'Overall change classification: LEGACY_PACKAGE_PATH',
      'Compatibility: legacy package path retained',
      'Cutover preflight required: yes',
    ].join('\n');
  }
  if (diff.overallChangeClassification === RELEASE_CHANGE_CLASSIFICATIONS.currentUnavailable) {
    return [
      `Exam: ${diff.examKey}`,
      `Current version: ${diff.currentPackageVersion ?? 'unresolved'}`,
      `Candidate version: ${diff.candidatePackageVersion}`,
      'Overall change classification: CURRENT_STATE_UNAVAILABLE',
      `Migration classification: ${diff.migrationClassification}`,
      `Compatibility: blocked (${diff.findings.join(', ')})`,
      'Cutover preflight required: yes',
    ].join('\n');
  }

  const questions = diff.questionInventory;
  return [
    `Exam: ${diff.examKey}`,
    `Current version: ${diff.currentPackageVersion}`,
    `Candidate version: ${diff.candidatePackageVersion}`,
    `Overall change classification: ${diff.overallChangeClassification}`,
    `Migration classification: ${diff.migrationClassification}`,
    `Questions: +${questions.addedCount} / -${questions.removedCount} / changed ${questions.changedCount} / unchanged ${questions.unchangedCount}`,
    `Interaction changes: ${formatKeyedChanges(diff.aggregateInventory.byInteractionType)}`,
    `Domain/objective changes: ${formatKeyedChanges(diff.aggregateInventory.byDomain)} / ${formatKeyedChanges(diff.aggregateInventory.byObjective)}`,
    `Profiles: +${diff.profiles.addedProfiles.length} / -${diff.profiles.removedProfiles.length} / changed ${diff.profiles.changedProfiles.length}`,
    `Forms: +${diff.forms.formsAdded} / -${diff.forms.formsRemoved} / changed ${diff.forms.formsChanged} / unchanged ${diff.forms.formsUnchanged}`,
    `Runtime: ${diff.runtime.changed ? 'changed' : 'unchanged'}`,
    `Capabilities: +${diff.capabilities.addedCapabilities.join(',') || 'none'} / -${diff.capabilities.removedCapabilities.join(',') || 'none'}`,
    `Release policy: ${diff.releasePolicy.changed ? 'changed' : 'unchanged'}`,
    `Exact duplicate findings: ${diff.exactHashReport.findingCodes.join(', ') || 'none'}`,
    `Compatibility: ${diff.compatibility.overall}`,
    'Cutover preflight required: yes',
  ].join('\n');
}

function compareQuestionInventories(currentEntries, candidateEntries) {
  const currentValid = validFingerprintIndex(currentEntries);
  const candidateValid = validFingerprintIndex(candidateEntries);
  if (!currentValid || !candidateValid) {
    return {
      status: 'QUESTION_IDENTITY_COMPARISON_UNAVAILABLE',
      currentCount: Array.isArray(currentEntries) ? currentEntries.length : null,
      candidateCount: Array.isArray(candidateEntries) ? candidateEntries.length : null,
      addedCount: null,
      removedCount: null,
      changedCount: null,
      unchangedCount: null,
      candidateComparableInventory: null,
      currentComparableInventory: null,
    };
  }
  const currentMap = firstFingerprintByIdentity(currentEntries);
  const candidateMap = firstFingerprintByIdentity(candidateEntries);
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  for (const [identity, hash] of candidateMap) {
    if (!currentMap.has(identity)) addedCount += 1;
    else if (currentMap.get(identity) === hash) unchangedCount += 1;
    else changedCount += 1;
  }
  for (const identity of currentMap.keys()) {
    if (!candidateMap.has(identity)) removedCount += 1;
  }
  return {
    status: 'AVAILABLE',
    currentCount: currentMap.size,
    candidateCount: candidateMap.size,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount,
    candidateComparableInventory: addedCount + changedCount + unchangedCount,
    currentComparableInventory: removedCount + changedCount + unchangedCount,
  };
}

function createDuplicateReport(currentEntries, candidateEntries, comparison) {
  const identityCounts = countBy(candidateEntries, (entry) => entry.identity);
  const hashCounts = countBy(candidateEntries, (entry) => entry.contentHash);
  const identitiesByHash = new Map();
  for (const entry of candidateEntries) {
    if (!entry.contentHash || !entry.identity) continue;
    const identities = identitiesByHash.get(entry.contentHash) ?? new Set();
    identities.add(entry.identity);
    identitiesByHash.set(entry.contentHash, identities);
  }
  const duplicateStableIdentityCount = sumDuplicateOccurrences(identityCounts);
  const duplicateCanonicalContentHashCount = [...hashCounts.values()]
    .filter((count) => count > 1).length;
  const duplicateCanonicalContentOccurrenceCount = sumDuplicateOccurrences(hashCounts);
  const identicalContentReusedUnderMultipleIdentitiesCount = [...identitiesByHash.values()]
    .reduce((sum, identities) => sum + Math.max(0, identities.size - 1), 0);
  const currentIdsByHash = new Map();
  for (const entry of Array.isArray(currentEntries) ? currentEntries : []) {
    if (!entry?.contentHash || !entry?.identity) continue;
    const identities = currentIdsByHash.get(entry.contentHash) ?? new Set();
    identities.add(entry.identity);
    currentIdsByHash.set(entry.contentHash, identities);
  }
  const uniqueCandidate = firstFingerprintByIdentity(candidateEntries);
  let sameHashUnderDifferentIdentityCount = 0;
  for (const [identity, hash] of uniqueCandidate) {
    const previousIdentities = currentIdsByHash.get(hash);
    if (previousIdentities && !previousIdentities.has(identity)) {
      sameHashUnderDifferentIdentityCount += 1;
    }
  }
  const findingCodes = uniqueSorted([
    ...(duplicateStableIdentityCount > 0 ? ['EXACT_DUPLICATE_ERROR'] : []),
    ...(duplicateCanonicalContentHashCount > 0
      || identicalContentReusedUnderMultipleIdentitiesCount > 0
      || sameHashUnderDifferentIdentityCount > 0
      ? ['CONTENT_REUSE_WARNING']
      : []),
    ...(comparison.unchangedCount > 0 ? ['UNCHANGED_CONTENT'] : []),
  ]);
  return {
    duplicateStableIdentityCount,
    duplicateCanonicalContentHashCount,
    duplicateCanonicalContentOccurrenceCount,
    identicalContentReusedUnderMultipleIdentitiesCount,
    crossVersionUnchangedContentCount: comparison.unchangedCount,
    crossVersionSameHashUnderDifferentIdentityCount: sameHashUnderDifferentIdentityCount,
    semanticDuplicateDetectionDeferred: true,
    findingCodes,
  };
}

function compareInventory(current, candidate) {
  const report = {};
  let changed = false;
  for (const field of INVENTORY_FIELDS) {
    report[field] = numericDelta(current?.[field], candidate?.[field]);
    changed ||= report[field].delta !== 0;
  }
  report.byInteractionType = keyedCountDiff(
    current?.byInteractionType,
    candidate?.byInteractionType,
  );
  report.byDomain = keyedCountDiff(current?.byDomain, candidate?.byDomain);
  report.byObjective = keyedCountDiff(current?.byObjective, candidate?.byObjective);
  changed ||= [report.byInteractionType, report.byDomain, report.byObjective]
    .some((entries) => entries.some((entry) => entry.delta !== 0));
  return { ...report, changed };
}

function compareRuntime(current, candidate) {
  const currentRuntime = current.runtime ?? {};
  const candidateRuntime = candidate.runtime ?? {};
  const compatibility = classifyRuntimeCompatibility(
    candidateRuntime,
    candidate.capabilities,
  );
  const fields = {
    generatorVersion: runtimeField(
      currentRuntime.generatorVersion,
      candidateRuntime.generatorVersion,
      compatibility,
    ),
    scorerVersion: runtimeField(
      currentRuntime.scorerVersion,
      candidateRuntime.scorerVersion,
      compatibility,
    ),
    pbqRuntimeVersion: runtimeField(
      currentRuntime.pbqRuntimeVersion,
      candidateRuntime.pbqRuntimeVersion,
      compatibility,
    ),
    executorRequirement: runtimeField(
      currentRuntime.executorRequirement,
      candidateRuntime.executorRequirement,
      compatibility,
    ),
    languageRequirements: currentRuntime.languageRequirements?.status === 'NOT_AVAILABLE'
      ? {
          current: 'NOT_AVAILABLE',
          candidate: candidate.languageCapabilities,
          state: 'COMPARISON_UNAVAILABLE',
        }
      : runtimeField(
          currentRuntime.languageRequirements?.values ?? [],
          candidate.languageCapabilities,
          compatibility,
        ),
  };
  return {
    changed: Object.values(fields).some(
      (entry) => ['SUPPORTED_CHANGE', 'PLATFORM_CAPABILITY_CHANGE_REQUIRED']
        .includes(entry.state),
    ),
    report: {
      ...fields,
      candidateRuntimeVerdict: compatibility.verdict,
      changed: Object.values(fields).some(
        (entry) => ['SUPPORTED_CHANGE', 'PLATFORM_CAPABILITY_CHANGE_REQUIRED']
          .includes(entry.state),
      ),
    },
  };
}

function runtimeField(current, candidate, compatibility) {
  if (same(current, candidate)) return { current, candidate, state: 'UNCHANGED' };
  return {
    current,
    candidate,
    state: compatibility.verdict === SUPPORTED_EXISTING_PLATFORM_CAPABILITY
      ? 'SUPPORTED_CHANGE'
      : 'PLATFORM_CAPABILITY_CHANGE_REQUIRED',
  };
}

function compareProfiles(currentProfiles, candidateProfiles) {
  const current = mapBy(currentProfiles, (profile) => profile.profileKey);
  const candidate = mapBy(candidateProfiles, (profile) => profile.profileKey);
  const addedProfiles = [...candidate.keys()].filter((key) => !current.has(key)).sort(compareText);
  const removedProfiles = [...current.keys()].filter((key) => !candidate.has(key)).sort(compareText);
  const changedProfiles = [];
  const unchangedProfiles = [];
  for (const key of [...candidate.keys()].filter((value) => current.has(value)).sort(compareText)) {
    const changes = [];
    for (const [field, read] of PROFILE_FIELDS) {
      const before = read(current.get(key));
      const after = read(candidate.get(key));
      if (!same(before, after)) changes.push({ field, current: before, candidate: after });
    }
    if (changes.length > 0) changedProfiles.push({ profileKey: key, changes });
    else unchangedProfiles.push(key);
  }
  return {
    changed: addedProfiles.length > 0 || removedProfiles.length > 0
      || changedProfiles.length > 0,
    report: {
      addedProfiles,
      removedProfiles,
      changedProfiles,
      unchangedProfiles,
    },
  };
}

function compareForms(currentProfiles, candidateProfiles) {
  const current = mapBy(currentProfiles, (profile) => profile.profileKey);
  const candidate = mapBy(candidateProfiles, (profile) => profile.profileKey);
  const profileReports = [];
  let totals = { formsAdded: 0, formsRemoved: 0, formsChanged: 0, formsUnchanged: 0 };
  let changed = false;
  for (const key of uniqueSorted([...current.keys(), ...candidate.keys()])) {
    const before = current.get(key)?.forms;
    const after = candidate.get(key)?.forms;
    if ((!before || before.formCount === 0) && (!after || after.formCount === 0)) {
      profileReports.push({ profileKey: key, state: 'NOT_APPLICABLE' });
      continue;
    }
    const counts = compareFormMemberships(
      before?.membershipHashes ?? [],
      after?.membershipHashes ?? [],
    );
    const aggregates = {
      itemCount: numericDelta(before?.itemCount, after?.itemCount),
      scoredItemCount: numericDelta(before?.scoredItemCount, after?.scoredItemCount),
      reserveItemCount: numericDelta(before?.reserveItemCount, after?.reserveItemCount),
    };
    const aggregateChanged = Object.values(aggregates).some((entry) => entry.delta !== 0);
    const profileChanged = counts.formsAdded > 0 || counts.formsRemoved > 0
      || counts.formsChanged > 0 || aggregateChanged
      || !same(before?.contractVersion ?? null, after?.contractVersion ?? null);
    changed ||= profileChanged;
    totals = {
      formsAdded: totals.formsAdded + counts.formsAdded,
      formsRemoved: totals.formsRemoved + counts.formsRemoved,
      formsChanged: totals.formsChanged + counts.formsChanged,
      formsUnchanged: totals.formsUnchanged + counts.formsUnchanged,
    };
    profileReports.push({
      profileKey: key,
      state: profileChanged ? 'CHANGED' : 'UNCHANGED',
      ...counts,
      aggregates,
    });
  }
  return {
    changed,
    report: { ...totals, profiles: profileReports },
  };
}

function compareFormMemberships(currentHashes, candidateHashes) {
  const current = countBy(currentHashes.map((contentHash) => ({ contentHash })),
    (entry) => entry.contentHash);
  const candidate = countBy(candidateHashes.map((contentHash) => ({ contentHash })),
    (entry) => entry.contentHash);
  let formsUnchanged = 0;
  for (const hash of new Set([...current.keys(), ...candidate.keys()])) {
    formsUnchanged += Math.min(current.get(hash) ?? 0, candidate.get(hash) ?? 0);
  }
  const unmatchedCurrent = currentHashes.length - formsUnchanged;
  const unmatchedCandidate = candidateHashes.length - formsUnchanged;
  const formsChanged = Math.min(unmatchedCurrent, unmatchedCandidate);
  return {
    formsAdded: unmatchedCandidate - formsChanged,
    formsRemoved: unmatchedCurrent - formsChanged,
    formsChanged,
    formsUnchanged,
  };
}

function compareObjectFields(current, candidate, fields) {
  const changes = fields.map((field) => ({
    field,
    current: current?.[field] ?? null,
    candidate: candidate?.[field] ?? null,
  })).filter((entry) => !same(entry.current, entry.candidate));
  return { changed: changes.length > 0, changes };
}

function compareSets(currentValues, candidateValues) {
  const current = uniqueSorted(currentValues ?? []);
  const candidate = uniqueSorted(candidateValues ?? []);
  return {
    added: candidate.filter((value) => !current.includes(value)),
    removed: current.filter((value) => !candidate.includes(value)),
    unchanged: candidate.filter((value) => current.includes(value)),
  };
}

function keyedCountDiff(currentEntries, candidateEntries) {
  const current = new Map((currentEntries ?? []).map((entry) => [entry.key, entry.count]));
  const candidate = new Map((candidateEntries ?? []).map((entry) => [entry.key, entry.count]));
  return uniqueSorted([...current.keys(), ...candidate.keys()]).map((key) => ({
    key,
    ...numericDelta(current.get(key), candidate.get(key)),
  }));
}

function numericDelta(current, candidate) {
  const before = Number.isSafeInteger(current) ? current : 0;
  const after = Number.isSafeInteger(candidate) ? candidate : 0;
  return { current: before, candidate: after, delta: after - before };
}

function validFingerprintIndex(entries) {
  return Array.isArray(entries) && entries.every((entry) => (
    typeof entry?.identity === 'string' && entry.identity
      && typeof entry?.contentHash === 'string'
      && /^[0-9a-f]{64}$/.test(entry.contentHash)
  ));
}

function firstFingerprintByIdentity(entries) {
  const result = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.identity && entry?.contentHash && !result.has(entry.identity)) {
      result.set(entry.identity, entry.contentHash);
    }
  }
  return result;
}

function countBy(entries, select) {
  const result = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = select(entry);
    if (!key) continue;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function sumDuplicateOccurrences(counts) {
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function safeQuestionHash(question) {
  try {
    return sha256Canonical({
      presentation: question.presentation ?? {},
      scoring: question.privateScoring ?? {},
      review: question.privateReview ?? {},
      group: question.group ?? {},
      scored: question.scored !== false,
    });
  } catch {
    return null;
  }
}

function mapBy(entries, select) {
  return new Map((Array.isArray(entries) ? entries : []).map((entry) => [select(entry), entry]));
}

function numberOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function same(left, right) {
  try {
    return canonicalSerialize(left) === canonicalSerialize(right);
  } catch {
    return false;
  }
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value))]
    .sort(compareText);
}

function formatKeyedChanges(entries) {
  const changes = entries.filter((entry) => entry.delta !== 0);
  return changes.length > 0
    ? changes.map((entry) => `${entry.key}:${entry.delta > 0 ? '+' : ''}${entry.delta}`).join(', ')
    : 'none';
}

function legacyDiff(candidateValidation) {
  const result = {
    releaseDiffSchema: EXAM_OPERATIONS_RELEASE_DIFF_SCHEMA,
    examKey: candidateValidation.examKey,
    currentPackageVersion: null,
    candidatePackageVersion: candidateValidation.packageVersion,
    overallChangeClassification: RELEASE_CHANGE_CLASSIFICATIONS.legacy,
    changeDimensions: [],
    migrationClassification: MIGRATION_CLASSIFICATIONS.legacy,
    findings: [MIGRATION_CLASSIFICATIONS.legacy],
    cutoverPreflightRequired: true,
  };
  assertSanitizedExamOperationsOutput(result);
  return deepFreeze(result);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const RUNTIME_CHANGE_REVIEW_REQUIRED = PLATFORM_CAPABILITY_CHANGE_REQUIRED;
