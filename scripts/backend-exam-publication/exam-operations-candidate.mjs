import {
  canonicalSerialize,
  sha256Canonical,
} from './canonical-json.mjs';
import {
  MULTI_EXAM_PACKAGE_SCHEMA_VERSION,
  MULTI_EXAM_VALIDATION_CONTRACT_VERSION,
  normalizeExamKey,
  validateMultiExamPackageContract,
} from './multi-exam-contract.mjs';
import {
  CAPABILITY_COMPATIBILITY_REGISTRY,
  CAPABILITY_COMPATIBILITY_REGISTRY_VERSION,
  EXECUTABLE_CAPABILITY,
  PBQ_CAPABILITIES,
  PLATFORM_CAPABILITY_CHANGE_REQUIRED,
  PYTHON_EXECUTOR_REQUIREMENT,
  SUPPORTED_EXISTING_PLATFORM_CAPABILITY,
  classifyCapabilityCompatibility,
  classifyRuntimeCompatibility,
} from './exam-operations-capability-registry.mjs';

export const EXAM_OPERATIONS_MANIFEST_SCHEMA =
  'certsim-exam-operations-manifest-v1';
export const EXAM_OPERATIONS_VALIDATOR_VERSION =
  'certsim-exam-operations-candidate-validator-v1';

export const MIGRATION_CLASSIFICATIONS = Object.freeze({
  contentRelease: 'CONTENT_RELEASE_NO_MIGRATION_EXPECTED',
  capabilityChange: 'PLATFORM_CAPABILITY_CHANGE_REVIEW_REQUIRED',
  invalid: 'INVALID_CANDIDATE',
  legacy: 'LEGACY_PACKAGE_PATH',
});

const LEGACY_PACKAGE_SCHEMA = 'certsim-protected-package-v1';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PBQ_SET = new Set(PBQ_CAPABILITIES);
const INFORMATIONAL_TYPES = new Set(['case-study-context', 'informational']);
const LANGUAGE_CAPABILITIES = new Set(['csharp', 'python', 'mixed']);
const CURRENT_FORM_CONTRACTS = new Set([
  'certsim-canonical-forms-v2',
  'certsim-python-standard-forms-v1',
]);
const PROHIBITED_MANIFEST_KEYS = new Set([
  'prompt', 'stem', 'question', 'questiontext', 'option', 'options',
  'answer', 'answers', 'answerkey', 'correctanswer', 'correctanswers',
  'correctorder', 'correctpairs', 'explanation', 'remediation', 'rubric',
  'scoringkey', 'scoringkeys', 'scoringrules', 'hiddentest',
  'hiddentests', 'modelsolution', 'privateauthoringmetadata',
  'privatestate', 'gradingmaterial',
]);

export function validateExamOperationsCandidate(contract, context = {}) {
  if (contract?.packageSchemaVersion === LEGACY_PACKAGE_SCHEMA) {
    return legacyResult(contract);
  }

  const errors = [];
  const warnings = [];
  const capabilities = uniqueSorted(contract?.exam?.capabilities);
  const capabilityCompatibility = classifyCapabilityCompatibility(capabilities);
  const unknownCapabilities = new Set(capabilityCompatibility.unsupported);
  let baseValidation = null;

  try {
    baseValidation = validateMultiExamPackageContract(contract);
  } catch (error) {
    const code = safeErrorCode(error);
    if (!(code === 'CAPABILITY_DECLARATION_INVALID' && unknownCapabilities.size > 0)) {
      addError(errors, code || 'PACKAGE_SCHEMA_INVALID');
    }
  }

  if (contract?.packageSchemaVersion !== MULTI_EXAM_PACKAGE_SCHEMA_VERSION) {
    addError(errors, 'PACKAGE_SCHEMA_UNSUPPORTED');
  }
  if (contract?.validationContractVersion !== MULTI_EXAM_VALIDATION_CONTRACT_VERSION) {
    addError(errors, 'VALIDATION_SCHEMA_UNSUPPORTED');
  }

  if (unknownCapabilities.size > 0) {
    addWarning(warnings, 'CAPABILITY_NOT_REGISTERED');
  }

  const questions = Array.isArray(contract?.questions) ? contract.questions : [];
  const profiles = Array.isArray(contract?.profiles) ? contract.profiles : [];
  validateDuplicateIdentities(questions, profiles, errors);
  const inventory = analyzeInventory(questions, errors);
  validateLanguageVariants(contract?.exam?.languagePreferences, questions, errors);
  const profileResults = profiles.map((profile) => validateProfile(
    profile,
    inventory,
    errors,
  ));
  validateCrossProfileForms(profileResults, errors);

  if (Array.isArray(contract?.exam?.languagePreferences)
      && contract.exam.languagePreferences.length > 0) {
    addWarning(warnings, 'LANGUAGE_VARIANT_CONTENT_REMAINS_PRIVATE');
  }

  const runtimeCompatibility = classifyRuntimeCompatibility(
    contract?.runtime,
    capabilities,
  );
  runtimeCompatibility.reasons.forEach((code) => addWarning(warnings, code));

  const capabilityChange = capabilityCompatibility.verdict
      === PLATFORM_CAPABILITY_CHANGE_REQUIRED
    || runtimeCompatibility.verdict === PLATFORM_CAPABILITY_CHANGE_REQUIRED;
  const invalid = errors.length > 0;
  const migrationClassification = invalid
    ? MIGRATION_CLASSIFICATIONS.invalid
    : capabilityChange
      ? MIGRATION_CLASSIFICATIONS.capabilityChange
      : MIGRATION_CLASSIFICATIONS.contentRelease;
  const overall = invalid
    ? 'incompatible'
    : capabilityChange
      ? 'review_required'
      : 'compatible';
  const validationVerdict = invalid
    ? 'invalid'
    : capabilityChange
      ? 'review_required'
      : 'valid';
  const formsPresent = profileResults.some(({ forms }) => forms.classification === 'fixed');
  const formsInvalid = errors.some(({ scope }) => scope === 'forms');
  const compositionInvalid = errors.some(({ scope }) => scope === 'profile');
  const registeredCapabilities = capabilities.filter(
    (capability) => CAPABILITY_COMPATIBILITY_REGISTRY[capability],
  );
  const layerSupport = summarizeCapabilityLayers(registeredCapabilities);

  const compatibility = Object.freeze({
    registryVersion: CAPABILITY_COMPATIBILITY_REGISTRY_VERSION,
    packageSchema: baseValidation === null ? 'unsupported' : 'supported',
    profileComposition: compositionInvalid ? 'invalid' : 'valid',
    forms: formsPresent ? (formsInvalid ? 'invalid' : 'valid') : 'not_applicable',
    response: unknownCapabilities.size > 0 ? 'unsupported' : layerSupport.response,
    scoring: unknownCapabilities.size > 0 ? 'unsupported' : layerSupport.scoring,
    runtime: runtimeCompatibility.verdict === SUPPORTED_EXISTING_PLATFORM_CAPABILITY
      ? 'supported'
      : 'unsupported',
    releasedReview: unknownCapabilities.size > 0
      ? 'unsupported'
      : layerSupport.releasedReview,
    practice: unknownCapabilities.size > 0 ? 'unsupported' : layerSupport.practice,
    historicalCompatibility: !invalid && !capabilityChange ? 'supported' : 'review_required',
    runtimeVerdict: runtimeCompatibility.verdict,
    migration: migrationClassification,
    cutoverPreflightRequired: true,
    overall,
    reasons: uniqueSorted([
      ...capabilityCompatibility.unsupported.map(() => 'CAPABILITY_NOT_REGISTERED'),
      ...runtimeCompatibility.reasons,
    ]),
  });

  let packageHash = null;
  try {
    packageHash = sha256Canonical(contract);
  } catch {
    addError(errors, 'PACKAGE_CANONICALIZATION_INVALID');
  }

  const sortedErrors = sortFindings(errors);
  const sortedWarnings = sortFindings(warnings);
  const manifest = buildManifest({
    contract,
    context,
    inventory,
    profileResults,
    packageHash,
    compatibility: {
      ...compatibility,
      migration: errors.length > 0
        ? MIGRATION_CLASSIFICATIONS.invalid
        : compatibility.migration,
      overall: errors.length > 0 ? 'incompatible' : compatibility.overall,
    },
    validationVerdict: errors.length > 0 ? 'invalid' : validationVerdict,
    errors: sortedErrors,
    warnings: sortedWarnings,
  });
  assertSanitizedManifest(manifest);
  const manifestHash = sha256Canonical(manifest);

  return Object.freeze({
    ok: errors.length === 0 && !capabilityChange,
    manifest,
    manifestHash,
    canonicalManifest: canonicalSerialize(manifest),
    validation: Object.freeze({
      verdict: errors.length > 0 ? 'invalid' : validationVerdict,
      validatorVersion: EXAM_OPERATIONS_VALIDATOR_VERSION,
      errors: sortedErrors,
      warnings: sortedWarnings,
      basePackageValidated: baseValidation !== null,
    }),
    compatibility: manifest.compatibility,
    migrationClassification: manifest.compatibility.migration,
  });
}

export function assertSanitizedManifest(manifest) {
  walkManifest(manifest, '$');
  return true;
}

export function formatExamOperationsValidationReport(result) {
  if (!result?.manifest) {
    return [
      `Exam: ${safeDisplay(result?.examKey)}`,
      `Candidate version: ${safeDisplay(result?.packageVersion)}`,
      'Predecessor/current version: not supplied',
      `Schema: ${safeDisplay(result?.packageSchemaVersion)}`,
      'Question inventory: unavailable on legacy path',
      'Interaction inventory: unavailable on legacy path',
      'Profiles: unavailable on legacy path',
      'Forms: unavailable on legacy path',
      'Runtime compatibility: legacy path',
      'Review compatibility: legacy path',
      `Migration classification: ${result?.migrationClassification}`,
      'Validation: legacy package path retained',
      'Warnings: LEGACY_PACKAGE_PATH',
    ].join('\n');
  }

  const { manifest } = result;
  const relationship = manifest.candidate.relationship;
  const profileSummary = manifest.profiles
    .map((profile) => `${profile.profileKey}:${profile.scoredQuestionCount}`)
    .join(', ');
  const formSummary = manifest.profiles
    .map((profile) => `${profile.profileKey}:${profile.forms.formCount}`)
    .join(', ');
  return [
    `Exam: ${manifest.candidate.examKey}`,
    `Candidate version: ${manifest.candidate.packageVersion}`,
    `Predecessor/current version: ${relationship.predecessorPackageVersion ?? 'none'} / ${relationship.currentPackageVersion ?? 'none'}`,
    `Schema: ${manifest.packageSchemaVersion} / ${manifest.validationSchemaVersion}`,
    `Question inventory: ${manifest.inventory.totalItemCount} items; ${manifest.inventory.scoredItemCount} scored; ${manifest.inventory.informationalItemCount} informational`,
    `Interaction inventory: ${manifest.inventory.byInteractionType.map(({ key, count }) => `${key}:${count}`).join(', ')}`,
    `Profiles: ${profileSummary || 'none'}`,
    `Forms: ${formSummary || 'none'}`,
    `Runtime compatibility: ${manifest.compatibility.runtimeVerdict}`,
    `Review compatibility: ${manifest.compatibility.releasedReview}`,
    `Migration classification: ${manifest.compatibility.migration}`,
    `Validation: ${manifest.validation.verdict}`,
    `Warnings: ${manifest.validation.warningCodes.join(', ') || 'none'}`,
    `Manifest hash: ${result.manifestHash}`,
  ].join('\n');
}

function buildManifest({
  contract,
  context,
  inventory,
  profileResults,
  packageHash,
  compatibility,
  validationVerdict,
  errors,
  warnings,
}) {
  const examKey = safeIdentifier(normalizeExamKey(contract?.exam?.examKey)) ?? 'invalid';
  const packageVersion = safeVersion(contract?.exam?.packageVersion) ?? 'invalid';
  const currentPackageVersion = safeVersion(context.currentPackageVersion) ?? null;
  const predecessorPackageVersion = safeVersion(context.predecessorPackageVersion) ?? null;
  const capabilities = uniqueSorted(contract?.exam?.capabilities)
    .filter((capability) => safeIdentifier(capability));

  return Object.freeze({
    manifestSchema: EXAM_OPERATIONS_MANIFEST_SCHEMA,
    packageSchemaVersion: safeIdentifier(contract?.packageSchemaVersion) ?? 'invalid',
    validationSchemaVersion: safeIdentifier(contract?.validationContractVersion) ?? 'invalid',
    candidate: Object.freeze({
      examKey,
      packageVersion,
      relationship: Object.freeze({
        currentPackageVersion,
        predecessorPackageVersion,
      }),
    }),
    hashes: Object.freeze({
      sourceHash: safeHash(contract?.source?.sourceHash),
      validationHash: safeHash(contract?.source?.validationHash),
      packageHash,
    }),
    inventory: Object.freeze({
      totalItemCount: inventory.totalItemCount,
      scoredItemCount: inventory.scoredItemCount,
      informationalItemCount: inventory.informationalItemCount,
      contextItemCount: inventory.contextItemCount,
      caseStudyGroupCount: inventory.caseGroups.length,
      scoredCaseItemCount: inventory.scoredCaseItemCount,
      pbqItemCount: inventory.pbqItemCount,
      executableLabItemCount: inventory.executableLabItemCount,
      byInteractionType: countEntries(inventory.byType),
      byDomain: countEntries(inventory.byDomain),
      byObjective: countEntries(inventory.byObjective),
    }),
    capabilities,
    languageCapabilities: sanitizeLanguageCapabilities(
      contract?.exam?.languagePreferences,
    ),
    profiles: profileResults
      .map(({ manifest }) => manifest)
      .sort((left, right) => compareText(left.profileKey, right.profileKey)),
    runtime: Object.freeze({
      generatorVersion: safeIdentifier(contract?.runtime?.generatorVersion) ?? 'invalid',
      scorerVersion: safeIdentifier(contract?.runtime?.scorerVersion) ?? 'invalid',
      pbqRuntimeVersion: safeIdentifier(contract?.runtime?.pbqRuntimeVersion) ?? null,
      executorRequirement: compatibility.runtime === 'supported'
        && capabilities.includes(EXECUTABLE_CAPABILITY)
        ? PYTHON_EXECUTOR_REQUIREMENT
        : null,
    }),
    releasePolicy: Object.freeze({
      reviewReleasePolicy: safeIdentifier(contract?.releasePolicy?.review) ?? 'invalid',
      answerReleasePolicy: safeIdentifier(contract?.releasePolicy?.answers) ?? 'invalid',
    }),
    validation: Object.freeze({
      verdict: validationVerdict,
      validatorVersion: EXAM_OPERATIONS_VALIDATOR_VERSION,
      errorCodes: uniqueSorted(errors.map(({ code }) => code)),
      warningCodes: uniqueSorted(warnings.map(({ code }) => code)),
    }),
    compatibility: Object.freeze(compatibility),
  });
}

function analyzeInventory(questions, errors) {
  const byType = new Map();
  const byDomain = new Map();
  const byObjective = new Map();
  const questionById = new Map();
  const groups = new Map();
  let scoredItemCount = 0;
  let informationalItemCount = 0;
  let contextItemCount = 0;
  let pbqItemCount = 0;
  let executableLabItemCount = 0;
  let scoredCaseItemCount = 0;

  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
    const id = typeof question.id === 'string' ? question.id : '';
    if (id && !questionById.has(id)) questionById.set(id, question);
    const type = safeIdentifier(question.type) ?? 'invalid';
    const domain = safeIdentifier(question.domainKey) ?? 'unspecified';
    const objective = objectiveKey(question);
    increment(byType, type);
    increment(byDomain, domain);
    if (objective) increment(byObjective, objective);
    const scored = question.scored !== false;
    if (scored) scoredItemCount += 1;
    if (INFORMATIONAL_TYPES.has(type)) informationalItemCount += 1;
    if (type === 'case-study-context') contextItemCount += 1;
    if (type.startsWith('pbq-')) pbqItemCount += 1;
    if (type === EXECUTABLE_CAPABILITY) executableLabItemCount += 1;

    const group = question.group;
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      const key = typeof group.groupKey === 'string' ? group.groupKey : '';
      const role = typeof group.role === 'string' ? group.role : '';
      if (key) {
        const existing = groups.get(key) ?? {
          key,
          groupSize: typeof group.groupSize === 'string' ? group.groupSize : null,
          contexts: 0,
          scoredChildren: 0,
          roles: new Set(),
        };
        existing.roles.add(role);
        if (role === 'context') existing.contexts += 1;
        if (role === 'question' && scored) {
          existing.scoredChildren += 1;
          scoredCaseItemCount += 1;
        }
        groups.set(key, existing);
      }
    }
  }

  for (const group of groups.values()) {
    if (group.roles.has('question') && group.contexts !== 1) {
      addError(errors, 'CASE_GROUP_CONTEXT_INVALID', { scope: 'inventory' });
    }
  }

  return {
    totalItemCount: questions.length,
    scoredItemCount,
    informationalItemCount,
    contextItemCount,
    pbqItemCount,
    executableLabItemCount,
    scoredCaseItemCount,
    byType,
    byDomain,
    byObjective,
    questionById,
    questions,
    groups,
    caseGroups: [...groups.values()].filter((group) => group.contexts === 1),
  };
}

function validateProfile(profile, inventory, errors) {
  const profileKey = safeIdentifier(profile?.profileKey) ?? 'invalid-profile';
  const questionCount = integer(profile?.questionCount) ? profile.questionCount : 0;
  const selection = plainObject(profile?.selection) ? profile.selection : {};
  const forms = validateForms(selection.canonicalForms, profileKey, questionCount, inventory, errors);
  const composition = validateProfileComposition(
    selection,
    profileKey,
    questionCount,
    inventory,
    forms,
    errors,
  );
  const deliveredItemCount = questionCount + composition.caseStudyCount;

  return Object.freeze({
    profileKey,
    reserveSignature: forms.reserveSignature,
    forms,
    manifest: Object.freeze({
      profileKey,
      displayName: safeDisplay(profile?.displayName || profileKey),
      questionCount,
      scoredQuestionCount: questionCount,
      deliveredItemCount,
      timeLimitMinutes: integer(profile?.timeLimitMinutes)
        ? profile.timeLimitMinutes
        : 0,
      selectionClassification: forms.classification,
      composition: Object.freeze(composition),
      sectionOrder: sanitizeSectionOrder(selection.sectionOrder),
      forms: forms.manifest,
    }),
  });
}

function validateProfileComposition(selection, profileKey, questionCount, inventory, forms, errors) {
  const canonicalFixed = forms.classification === 'fixed';
  const standardFields = [
    readIntegerField(selection, 'standardQuestionCount'),
    readIntegerField(selection, 'normalScoredQuestionCount'),
  ];
  const explicitStandard = standardFields.find(({ valid }) => valid)?.value;
  if (standardFields.filter(({ valid }) => valid).length === 2
      && standardFields[0].value !== standardFields[1].value) {
    profileError(errors, profileKey, 'PROFILE_COMPOSITION_INCONSISTENT');
  }

  const explicitCaseCount = readIntegerField(selection, 'caseStudyCount');
  const longCount = readIntegerField(selection, 'longCaseStudyCount');
  const shortCount = readIntegerField(selection, 'shortCaseStudyCount');
  const caseQuestionField = readIntegerField(selection, 'caseStudyQuestionCount');
  const caseStudyCount = explicitCaseCount.valid
    ? explicitCaseCount.value
    : (longCount.valid ? longCount.value : 0) + (shortCount.valid ? shortCount.value : 0);
  const pbqField = readIntegerField(selection, 'pbqCount');
  const executableField = readIntegerField(selection, 'executableCount');
  let pbqCount = pbqField.valid ? pbqField.value : 0;
  let executableCount = executableField.valid ? executableField.value : 0;
  const mixed = caseStudyCount > 0 || pbqCount > 0 || executableCount > 0;
  const malformedNumeric = [
    ...standardFields,
    explicitCaseCount,
    longCount,
    shortCount,
    caseQuestionField,
    pbqField,
    executableField,
  ].some(({ present, valid }) => present && !valid);

  if (malformedNumeric || (mixed && explicitStandard === undefined)) {
    profileError(errors, profileKey, 'PROFILE_COMPOSITION_INCONSISTENT');
  }

  let standardQuestionCount = explicitStandard;
  let caseStudyQuestionCount = caseQuestionField.valid
    ? caseQuestionField.value
    : undefined;

  if (canonicalFixed && explicitStandard === undefined) {
    const firstForm = forms.memberQuestions[0] ?? [];
    const fixedCounts = countQuestionClasses(firstForm);
    standardQuestionCount = fixedCounts.standard;
    caseStudyQuestionCount = fixedCounts.caseStudy;
    if (!pbqField.present) pbqCount = fixedCounts.pbq;
    if (!executableField.present) executableCount = fixedCounts.executable;
  }
  if (standardQuestionCount === undefined) {
    standardQuestionCount = Math.max(0, questionCount - pbqCount - executableCount);
  }
  if (caseStudyQuestionCount === undefined) {
    caseStudyQuestionCount = caseStudyCount === 0
      ? 0
      : Math.max(
          0,
          questionCount - standardQuestionCount - pbqCount - executableCount,
        );
  }

  if (caseStudyCount === 0 && caseStudyQuestionCount !== 0) {
    profileError(errors, profileKey, 'CASE_STUDY_COUNT_CONTRADICTION');
  }
  if (caseStudyCount > 0 && caseStudyQuestionCount < caseStudyCount) {
    profileError(errors, profileKey, 'CASE_STUDY_COUNT_CONTRADICTION');
  }
  if (!canSelectCaseGroups(
    inventory.caseGroups,
    caseStudyCount,
    caseStudyQuestionCount,
    longCount.valid ? longCount.value : 0,
    shortCount.valid ? shortCount.value : 0,
  )) {
    profileError(errors, profileKey, 'CASE_STUDY_SELECTION_IMPOSSIBLE');
  }
  if (pbqCount > inventory.pbqItemCount) {
    profileError(errors, profileKey, 'PBQ_COUNT_CONTRADICTION');
  }
  if (executableCount > inventory.executableLabItemCount) {
    profileError(errors, profileKey, 'EXECUTABLE_COUNT_CONTRADICTION');
  }

  const standardInventory = inventory.questions.filter((question) => {
    const type = question?.type;
    const role = question?.group?.role;
    return question?.scored !== false
      && !PBQ_SET.has(type)
      && type !== EXECUTABLE_CAPABILITY
      && !['context', 'question', 'atomic-pbq'].includes(role);
  }).length;
  if (standardQuestionCount > standardInventory) {
    profileError(errors, profileKey, 'STANDARD_INVENTORY_INSUFFICIENT');
  }

  const calculatedTotal = standardQuestionCount
    + caseStudyQuestionCount
    + pbqCount
    + executableCount;
  if (calculatedTotal !== questionCount) {
    profileError(errors, profileKey, 'PROFILE_COMPOSITION_INCONSISTENT');
  }

  validateSectionOrder(selection.sectionOrder, {
    standard: standardQuestionCount,
    case: caseStudyCount,
    pbq: pbqCount,
    executable: executableCount,
  }, profileKey, errors);

  return {
    standardQuestionCount,
    caseStudyCount,
    caseStudyQuestionCount,
    pbqCount,
    executableCount,
  };
}

function validateForms(contract, profileKey, questionCount, inventory, errors) {
  if (contract === undefined) {
    return {
      classification: 'dynamic',
      memberQuestions: [],
      reserveSignature: null,
      manifest: Object.freeze({
        contractVersion: null,
        formCount: 0,
        itemCount: 0,
        scoredItemCount: 0,
        membershipHashes: [],
        reserveItemCount: 0,
      }),
    };
  }

  if (!plainObject(contract)) {
    formError(errors, profileKey, 'CANONICAL_FORM_CONTRACT_INVALID');
    return invalidForms();
  }
  const contractVersion = safeIdentifier(contract.contractVersion);
  const forms = Array.isArray(contract.forms) ? contract.forms : [];
  const reserves = Array.isArray(contract.reserveQuestionIds)
    ? contract.reserveQuestionIds
    : [];
  const cycleLength = integer(contract.cycleLength) ? contract.cycleLength : 0;
  if (!CURRENT_FORM_CONTRACTS.has(contractVersion)
      || cycleLength < 2 || cycleLength > 20
      || cycleLength !== forms.length
      || (contract.questionCount !== undefined && contract.questionCount !== questionCount)
      || (contract.profileKey !== undefined && contract.profileKey !== profileKey)) {
    formError(errors, profileKey, 'CANONICAL_FORM_CONTRACT_INVALID');
  }

  const reserveSet = new Set();
  for (const id of reserves) {
    if (typeof id !== 'string' || !id || reserveSet.has(id)
        || !inventory.questionById.has(id)) {
      formError(errors, profileKey, 'CANONICAL_FORM_RESERVE_INVALID');
      continue;
    }
    reserveSet.add(id);
  }

  const formKeys = new Set();
  const ordinals = new Set();
  const allMembers = new Set();
  const memberQuestions = [];
  const summaries = [];
  for (let index = 0; index < forms.length; index += 1) {
    const form = forms[index];
    if (!plainObject(form)) {
      formError(errors, profileKey, 'CANONICAL_FORM_DEFINITION_INVALID');
      continue;
    }
    const formKey = typeof form.formKey === 'string' ? form.formKey : '';
    const ordinal = form.ordinal;
    const ids = Array.isArray(form.questionIds) ? form.questionIds : [];
    if (!formKey || formKeys.has(formKey) || !integer(ordinal)
        || ordinals.has(ordinal) || ordinal !== index + 1
        || ids.length !== questionCount || new Set(ids).size !== ids.length
        || form.membershipHash !== safeCanonicalHash(ids)) {
      formError(errors, profileKey, 'CANONICAL_FORM_DEFINITION_INVALID');
    }
    formKeys.add(formKey);
    ordinals.add(ordinal);

    const resolved = [];
    for (const id of ids) {
      const question = inventory.questionById.get(id);
      if (!question || question.scored === false || reserveSet.has(id)
          || allMembers.has(id)) {
        formError(errors, profileKey, 'CANONICAL_FORM_MEMBERSHIP_INVALID');
      }
      if (question) resolved.push(question);
      allMembers.add(id);
    }
    memberQuestions.push(resolved);

    if (contractVersion === 'certsim-python-standard-forms-v1') {
      const rawMaximum = resolved.reduce(
        (total, question) => total + Number(question?.privateScoring?.maximumRawPoints ?? 0),
        0,
      );
      if (!Number.isFinite(form.rawMaximum) || form.rawMaximum <= 0
          || rawMaximum !== form.rawMaximum || resolved.length !== questionCount) {
        formError(errors, profileKey, 'CANONICAL_FORM_RAW_MAXIMUM_INVALID');
      }
    }

    summaries.push({
      ordinal: integer(ordinal) ? ordinal : 0,
      itemCount: ids.length,
      scoredItemCount: resolved.filter((question) => question.scored !== false).length,
      membershipHash: safeHash(form.membershipHash),
    });
  }

  if (contractVersion === 'certsim-python-standard-forms-v1') {
    const covered = new Set([...allMembers, ...reserveSet]);
    if (covered.size !== inventory.questionById.size
        || [...inventory.questionById.keys()].some((id) => !covered.has(id))) {
      formError(errors, profileKey, 'CANONICAL_FORM_RESERVE_INSUFFICIENT');
    }
  }

  if (contractVersion === 'certsim-canonical-forms-v2') {
    validateCanonicalBlueprint(contract, forms, inventory, profileKey, questionCount, errors);
  }

  return {
    classification: 'fixed',
    memberQuestions,
    reserveSignature: safeCanonicalHash([...reserveSet].sort()),
    manifest: Object.freeze({
      contractVersion,
      formCount: forms.length,
      itemCount: questionCount,
      scoredItemCount: questionCount,
      membershipHashes: summaries
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ membershipHash }) => membershipHash),
      reserveItemCount: reserveSet.size,
    }),
  };
}

function validateCanonicalBlueprint(contract, forms, inventory, profileKey, questionCount, errors) {
  const targets = plainObject(contract.skillGroupTargets)
    ? contract.skillGroupTargets
    : null;
  const objectives = Array.isArray(contract.requiredObjectiveKeys)
    ? contract.requiredObjectiveKeys
    : null;
  const coverage = plainObject(contract.minimumCoverageTagCounts)
    ? contract.minimumCoverageTagCounts
    : null;
  const difficulty = plainObject(contract.difficultyRequirements)
    ? contract.difficultyRequirements
    : null;
  if (!targets || !objectives || !coverage || !difficulty
      || sumIntegers(Object.values(targets)) !== questionCount
      || !integer(difficulty.minimumMedium)
      || !integer(difficulty.minimumHardOrAdvanced)
      || !integer(difficulty.minimumAdvanced)) {
    formError(errors, profileKey, 'CANONICAL_FORM_BLUEPRINT_INVALID');
    return;
  }

  for (const form of forms) {
    const questions = (Array.isArray(form?.questionIds) ? form.questionIds : [])
      .map((id) => inventory.questionById.get(id))
      .filter(Boolean);
    const difficulties = questions.map((question) => question.presentation?.difficulty);
    if (difficulties.filter((value) => value === 'medium').length < difficulty.minimumMedium
        || difficulties.filter((value) => ['hard', 'advanced'].includes(value)).length
          < difficulty.minimumHardOrAdvanced
        || difficulties.filter((value) => value === 'advanced').length
          < difficulty.minimumAdvanced) {
      formError(errors, profileKey, 'CANONICAL_FORM_BLUEPRINT_INVALID');
    }
    for (const [skillGroup, target] of Object.entries(targets)) {
      if (!integer(target) || questions.filter(
        (question) => question.presentation?.officialSkillGroup === skillGroup,
      ).length !== target) {
        formError(errors, profileKey, 'CANONICAL_FORM_BLUEPRINT_INVALID');
      }
    }
    for (const objective of objectives) {
      if (typeof objective !== 'string' || !questions.some(
        (question) => question.presentation?.officialObjectiveKey === objective,
      )) {
        formError(errors, profileKey, 'CANONICAL_FORM_BLUEPRINT_INVALID');
      }
    }
    for (const [tag, minimum] of Object.entries(coverage)) {
      if (!integer(minimum) || questions.filter(
        (question) => Array.isArray(question.presentation?.coverageTags)
          && question.presentation.coverageTags.includes(tag),
      ).length < minimum) {
        formError(errors, profileKey, 'CANONICAL_FORM_BLUEPRINT_INVALID');
      }
    }
  }
}

function validateDuplicateIdentities(questions, profiles, errors) {
  if (hasDuplicate(questions.map((question) => question?.id))) {
    addError(errors, 'QUESTION_ID_DUPLICATE', { scope: 'inventory' });
  }
  if (hasDuplicate(profiles.map((profile) => profile?.profileKey))) {
    addError(errors, 'PROFILE_KEY_DUPLICATE', { scope: 'profile' });
  }
}

function validateLanguageVariants(languagePreferences, questions, errors) {
  const languageAware = Array.isArray(languagePreferences)
    && languagePreferences.includes('csharp')
    && languagePreferences.includes('python');
  if (!languageAware) return;

  for (const question of questions) {
    const group = plainObject(question?.group) ? question.group : null;
    if (!group || !Object.hasOwn(group, 'languageVariants')) continue;
    const variants = group.languageVariants;
    if (!plainObject(variants)
        || !plainObject(variants.csharp)
        || !plainObject(variants.python)) {
      addError(errors, 'LANGUAGE_VARIANT_REQUIRED', { scope: 'inventory' });
    }
  }
}

function validateCrossProfileForms(profileResults, errors) {
  const fixed = profileResults.filter(({ forms }) => forms.classification === 'fixed');
  if (fixed.length < 2) return;
  const signatures = new Set(fixed.map(({ reserveSignature }) => reserveSignature));
  if (signatures.size > 1) {
    addError(errors, 'CANONICAL_FORM_CROSS_PROFILE_RESERVE_MISMATCH', { scope: 'forms' });
  }
}

function validateSectionOrder(value, counts, profileKey, errors) {
  const order = parseSectionOrder(value);
  if (order.length === 0) return;
  const normalized = order.map(normalizeSection);
  const expected = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([section]) => section)
    .sort();
  if (normalized.includes(null)
      || new Set(normalized).size !== normalized.length
      || normalized.some((section) => counts[section] === 0)
      || expected.some((section) => !normalized.includes(section))) {
    profileError(errors, profileKey, 'SECTION_ORDER_INVALID');
  }
}

function canSelectCaseGroups(groups, count, target, longCount, shortCount) {
  if (count === 0) return target === 0;
  if (groups.length < count || target < count) return false;
  let states = new Set(['0|0|0|0']);
  for (const group of groups) {
    const next = new Set(states);
    for (const state of states) {
      const [selected, longSelected, shortSelected, total] = state.split('|').map(Number);
      const values = [
        selected + 1,
        longSelected + (group.groupSize === 'long' ? 1 : 0),
        shortSelected + (group.groupSize === 'short' ? 1 : 0),
        total + group.scoredChildren,
      ];
      if (values[0] <= count && values[3] <= target) next.add(values.join('|'));
    }
    states = next;
  }
  return [...states].some((state) => {
    const [selected, selectedLong, selectedShort, total] = state.split('|').map(Number);
    return selected === count && total === target
      && (longCount === 0 && shortCount === 0
        ? true
        : selectedLong === longCount && selectedShort === shortCount);
  });
}

function countQuestionClasses(questions) {
  const result = { standard: 0, caseStudy: 0, pbq: 0, executable: 0 };
  for (const question of questions) {
    if (question?.group?.role === 'question') result.caseStudy += 1;
    else if (PBQ_SET.has(question?.type)) result.pbq += 1;
    else if (question?.type === EXECUTABLE_CAPABILITY) result.executable += 1;
    else result.standard += 1;
  }
  return result;
}

function summarizeCapabilityLayers(capabilities) {
  const records = capabilities.map(
    (capability) => CAPABILITY_COMPATIBILITY_REGISTRY[capability],
  ).filter(Boolean);
  return {
    response: records.every(({ responseSaveContract }) => responseSaveContract)
      ? 'supported'
      : 'unsupported',
    scoring: records.every(({ scorer }) => scorer) ? 'supported' : 'unsupported',
    releasedReview: records.every(({ releasedReview }) => releasedReview === 'supported')
      ? 'supported'
      : 'unsupported',
    practice: records.every(({ practice }) => practice === 'supported')
      ? 'supported'
      : 'unsupported',
  };
}

function legacyResult(contract) {
  return Object.freeze({
    ok: false,
    manifest: null,
    manifestHash: null,
    canonicalManifest: null,
    examKey: safeIdentifier(normalizeExamKey(contract?.exam?.examKey)) ?? 'legacy',
    packageVersion: safeVersion(contract?.exam?.packageVersion) ?? 'legacy',
    packageSchemaVersion: LEGACY_PACKAGE_SCHEMA,
    validation: Object.freeze({
      verdict: 'legacy',
      validatorVersion: EXAM_OPERATIONS_VALIDATOR_VERSION,
      errors: [],
      warnings: [{ code: MIGRATION_CLASSIFICATIONS.legacy, scope: 'package' }],
      basePackageValidated: false,
    }),
    compatibility: Object.freeze({
      packageSchema: 'legacy',
      overall: 'legacy',
      migration: MIGRATION_CLASSIFICATIONS.legacy,
      cutoverPreflightRequired: true,
    }),
    migrationClassification: MIGRATION_CLASSIFICATIONS.legacy,
  });
}

function invalidForms() {
  return {
    classification: 'fixed',
    memberQuestions: [],
    reserveSignature: null,
    manifest: Object.freeze({
      contractVersion: null,
      formCount: 0,
      itemCount: 0,
      scoredItemCount: 0,
      membershipHashes: [],
      reserveItemCount: 0,
    }),
  };
}

function readIntegerField(object, key) {
  const present = Object.hasOwn(object, key);
  const value = object[key];
  return { present, valid: integer(value), value };
}

function parseSectionOrder(value) {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item.trim() : null);
  }
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || !value.trim()) return [null];
  return value.split('-').map((item) => item.trim()).filter(Boolean);
}

function sanitizeSectionOrder(value) {
  return parseSectionOrder(value).map((section) => normalizeSection(section) ?? 'invalid');
}

function sanitizeLanguageCapabilities(values) {
  if (!Array.isArray(values)) return [];
  const valid = uniqueSorted(values).filter((value) => LANGUAGE_CAPABILITIES.has(value));
  const invalid = values.some(
    (value) => typeof value !== 'string' || !LANGUAGE_CAPABILITIES.has(value),
  );
  return uniqueSorted(invalid ? [...valid, 'invalid'] : valid);
}

function normalizeSection(value) {
  if (value === 'standard') return 'standard';
  if (value === 'case' || value === 'caseStudy' || value === 'case-study') return 'case';
  if (value === 'pbq') return 'pbq';
  if (value === 'executable' || value === 'lab') return 'executable';
  return null;
}

function objectiveKey(question) {
  const candidate = question?.sectionKey ?? question?.presentation?.officialObjectiveKey;
  return safeIdentifier(candidate);
}

function profileError(errors, profileKey, code) {
  addError(errors, code, { scope: 'profile', profileKey });
}

function formError(errors, profileKey, code) {
  addError(errors, code, { scope: 'forms', profileKey });
}

function addError(findings, code, details = {}) {
  const finding = sanitizedFinding(code, details);
  if (!findings.some((existing) => canonicalSerialize(existing) === canonicalSerialize(finding))) {
    findings.push(finding);
  }
}

function addWarning(findings, code, details = {}) {
  addError(findings, code, details);
}

function sanitizedFinding(code, details) {
  return Object.freeze({
    code: safeErrorCode({ code }) || 'CANDIDATE_VALIDATION_FAILED',
    scope: ['package', 'inventory', 'profile', 'forms', 'runtime'].includes(details.scope)
      ? details.scope
      : 'package',
    ...(details.profileKey ? { profileKey: safeIdentifier(details.profileKey) } : {}),
  });
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => (
    compareText(left.code, right.code)
      || compareText(left.scope, right.scope)
      || compareText(left.profileKey ?? '', right.profileKey ?? '')
  ));
}

function countEntries(map) {
  return [...map.entries()]
    .map(([key, count]) => Object.freeze({ key, count }))
    .sort((left, right) => compareText(left.key, right.key));
}

function walkManifest(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkManifest(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PROHIBITED_MANIFEST_KEYS.has(normalized)) {
      throw new Error(`MANIFEST_PROTECTED_FIELD_REJECTED [${path}.${key}]`);
    }
    walkManifest(entry, `${path}.${key}`);
  }
}

function safeErrorCode(error) {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : typeof error?.message === 'string'
      ? error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0]
      : '';
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(candidate ?? '') ? candidate : '';
}

function safeHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : null;
}

function safeCanonicalHash(value) {
  try {
    return sha256Canonical(value);
  } catch {
    return null;
  }
}

function safeVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null;
}

function safeIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value) ? value : null;
}

function safeDisplay(value) {
  if (typeof value !== 'string') return 'unavailable';
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized && normalized.length <= 120 ? normalized : 'unavailable';
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sumIntegers(values) {
  return values.every(integer) ? values.reduce((sum, value) => sum + value, 0) : -1;
}

function hasDuplicate(values) {
  const filtered = values.filter((value) => typeof value === 'string' && value);
  return new Set(filtered).size !== filtered.length;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function uniqueSorted(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string' && value),
  )].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
