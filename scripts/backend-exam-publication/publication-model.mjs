import { validateQuestionBank } from './validateQuestionBank.mjs';
import { canonicalSerialize, sha256Canonical } from './canonical-json.mjs';

export const PROTECTED_PACKAGE_SCHEMA_VERSION = 'certsim-protected-package-v1';
export const PROTECTED_VALIDATION_CONTRACT_VERSION =
  'certsim-protected-standard-validation-v1';
export const PROTECTED_GENERATOR_VERSION = 'certsim-protected-generator-v1';
export const PROTECTED_SCORER_VERSION = 'certsim-protected-standard-scorer-v1';

export const SUPPORTED_STANDARD_QUESTION_TYPES = Object.freeze([
  'single-choice',
  'multi-select',
  'drag-drop-match',
  'reorder',
  'dropdown-code',
  'dropdown-command',
]);

const SUPPORTED_TYPE_SET = new Set(SUPPORTED_STANDARD_QUESTION_TYPES);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BLOCKED_PRESENTATION_KEYS = new Set([
  'acceptedanswer',
  'acceptedanswers',
  'answer',
  'answerkey',
  'answers',
  'correctanswer',
  'correctanswers',
  'correctness',
  'correctorder',
  'correctpairs',
  'expectedactions',
  'expectedanswer',
  'expectedanswers',
  'explanation',
  'hiddenanswermetadata',
  'iscorrect',
  'maxpoints',
  'partialcredit',
  'points',
  'remediation',
  'rubric',
  'score',
  'scoring',
  'scoringkey',
  'scoringkeys',
  'scoringrules',
  'weight',
  'weights',
]);
const COMMON_QUESTION_FIELDS = new Set([
  'id',
  'type',
  'domain',
  'difficulty',
  'question',
  'explanation',
  'remediation',
  'officialSkillGroup',
  'skillGroup',
  'skillGroupLabel',
  'ai901Subskill',
  'topicTags',
  'betaBatch',
  'betaSample',
  'qualityStatus',
  'productionHardeningPhase',
  'remediationBatch',
]);
const TYPE_FIELDS = Object.freeze({
  'single-choice': new Set(['options', 'correctAnswer']),
  'multi-select': new Set(['options', 'correctAnswers']),
  'drag-drop-match': new Set(['prompts', 'options', 'correctPairs']),
  reorder: new Set(['items', 'correctOrder']),
  'dropdown-code': new Set(['codeTemplate', 'blanks']),
  'dropdown-command': new Set(['commandTemplate', 'codeTemplate', 'blanks']),
});

export class PublicationValidationError extends Error {
  constructor(code, references = []) {
    const safeReferences = references
      .filter((reference) => typeof reference === 'string' && reference.trim())
      .map((reference) => reference.trim());

    super(`${code}${safeReferences.length > 0 ? ` [${safeReferences.join('/')}]` : ''}`);
    this.name = 'PublicationValidationError';
    this.code = code;
    this.references = safeReferences;
  }
}

export function prepareProtectedPublication({
  source,
  metadata,
  existingPublications = [],
  validationOnly = false,
}) {
  validateMetadata(metadata, { validationOnly });
  validateSourceRoot(source, metadata.examKey);

  const domainContract = normalizeDomains(source.domains, metadata.examKey);
  const objectiveContract = normalizeObjectiveContract(
    source.objectiveContract,
    metadata.examKey,
  );
  const scoringContract = normalizeScoringContract(source.scoringContract, metadata.examKey);
  const seenQuestionIds = new Set();

  for (const question of source.questions) {
    if (typeof question?.id === 'string' && seenQuestionIds.has(question.id)) {
      fail('QUESTION_ID_DUPLICATE', metadata.examKey, question.id);
    }
    if (typeof question?.id === 'string') {
      seenQuestionIds.add(question.id);
    }
  }

  const normalizedQuestions = source.questions.map((question, index) => (
    normalizeQuestion({
      question,
      sourceOrdinal: index + 1,
      examKey: metadata.examKey,
      domainContract,
      objectiveContract,
    })
  ));
  const sourceIssues = validateQuestionBank(source.questions, {
    allowedQuestionTypes: [...SUPPORTED_STANDARD_QUESTION_TYPES],
    allowUnscoredItems: false,
    requireMultiSelectCountHint: source.requireMultiSelectCountHint === true,
    domainNames: domainContract.aliases,
  });
  const sourceError = sourceIssues.find((issue) => issue.level === 'error');

  if (sourceError) {
    fail('SOURCE_QUESTION_CONTRACT_INVALID', metadata.examKey, sourceError.questionId);
  }
  const normalizedProfiles = normalizeProfiles({
    profiles: source.profiles,
    examKey: metadata.examKey,
    questionCount: normalizedQuestions.length,
    domainContract,
    scoringContract,
  });
  const supportedTypes = [...new Set(normalizedQuestions.map(({ questionType }) => questionType))]
    .sort();
  const declaredTypes = [...new Set(source.supportedQuestionTypes)].sort();

  if (canonicalSerialize(supportedTypes) !== canonicalSerialize(declaredTypes)) {
    fail('SUPPORTED_TYPE_DECLARATION_MISMATCH', metadata.examKey);
  }

  const packageContent = {
    packageSchemaVersion: metadata.packageSchemaVersion,
    exam: {
      examKey: metadata.examKey,
      supportedQuestionTypes: declaredTypes,
      domains: domainContract.domains,
      objectiveContract: objectiveContract.normalized,
      scoringContract,
    },
    profiles: normalizedProfiles,
    questions: normalizedQuestions.map(({ contentHash: _contentHash, ...question }) => question),
  };
  const packageHash = sha256Canonical(packageContent);
  const questionTypeCounts = Object.fromEntries(
    declaredTypes.map((questionType) => [
      questionType,
      normalizedQuestions.filter((question) => question.questionType === questionType).length,
    ]),
  );
  const validationManifest = {
    validationContractVersion: metadata.validationContractVersion,
    packageHash,
    supportedQuestionTypes: declaredTypes,
    generatorVersion: metadata.generatorVersion,
    scorerVersion: metadata.scorerVersion,
    scoringModel: scoringContract.model,
    profileCount: normalizedProfiles.length,
    questionCount: normalizedQuestions.length,
    questionTypeCounts,
    validationResult: {
      errorCount: 0,
      warningCount: sourceIssues.filter((issue) => issue.level === 'warning').length,
      sourceValidatorContract: 'validateQuestionBank-v1',
    },
  };
  const validationHash = sha256Canonical(validationManifest);
  const candidateIdentity = {
    examKey: metadata.examKey,
    packageVersion: metadata.packageVersion ?? null,
    sourceCommitSha: metadata.sourceCommitSha,
    packageHash,
    validationHash,
  };
  const duplicateDetection = validationOnly
    ? { classification: 'validation_only', accepted: false, matchedIndex: null }
    : classifyPublicationIdentity(candidateIdentity, existingPublications);
  const publicationRequest = validationOnly || !duplicateDetection.accepted
    ? null
    : buildPublicationRequest({
      metadata,
      packageContent,
      packageHash,
      validationHash,
      validationManifest,
      profiles: normalizedProfiles,
      questions: normalizedQuestions,
    });
  const summary = createSanitizedPublicationSummary({
    metadata,
    questionTypeCounts,
    questionCount: normalizedQuestions.length,
    profileCount: normalizedProfiles.length,
    packageHash,
    validationHash,
    duplicateDetection,
    publicationRequestBuilt: publicationRequest !== null,
  });

  return {
    packageContent,
    validationManifest,
    packageHash,
    validationHash,
    duplicateDetection,
    publicationRequest,
    summary,
  };
}

export function classifyPublicationIdentity(candidate, existingPublications = []) {
  validatePublicationIdentity(candidate, 'candidate');

  const existing = existingPublications.map((identity, index) => {
    validatePublicationIdentity(identity, `existing-${index}`);
    return identity;
  });
  const versionMatchIndex = existing.findIndex((identity) => (
    identity.examKey === candidate.examKey &&
    identity.packageVersion === candidate.packageVersion
  ));

  if (versionMatchIndex >= 0) {
    const match = existing[versionMatchIndex];

    if (match.packageHash !== candidate.packageHash) {
      return conflict('version_conflict', versionMatchIndex);
    }
    if (match.validationHash !== candidate.validationHash) {
      return conflict('validation_conflict', versionMatchIndex);
    }
    if (match.sourceCommitSha !== candidate.sourceCommitSha) {
      return conflict('source_identity_conflict', versionMatchIndex);
    }

    return {
      classification: 'idempotent_duplicate',
      accepted: true,
      matchedIndex: versionMatchIndex,
    };
  }

  const duplicateContentIndex = existing.findIndex(
    (identity) => identity.packageHash === candidate.packageHash,
  );

  if (duplicateContentIndex >= 0) {
    return conflict('duplicate_content', duplicateContentIndex);
  }

  const sourceConflictIndex = existing.findIndex((identity) => (
    identity.examKey === candidate.examKey &&
    identity.sourceCommitSha === candidate.sourceCommitSha &&
    identity.packageHash !== candidate.packageHash
  ));

  if (sourceConflictIndex >= 0) {
    return conflict('source_package_conflict', sourceConflictIndex);
  }

  return { classification: 'new_candidate', accepted: true, matchedIndex: null };
}

export function createSanitizedPublicationSummary({
  metadata,
  questionTypeCounts,
  questionCount,
  profileCount,
  packageHash,
  validationHash,
  duplicateDetection,
  publicationRequestBuilt,
}) {
  return Object.freeze({
    examKey: metadata.examKey,
    packageVersion: metadata.packageVersion ?? null,
    sourceCommitSha: metadata.sourceCommitSha,
    packageSchemaVersion: metadata.packageSchemaVersion,
    validationContractVersion: metadata.validationContractVersion,
    generatorVersion: metadata.generatorVersion,
    scorerVersion: metadata.scorerVersion,
    profileCount,
    questionCount,
    questionTypeCounts: Object.freeze({ ...questionTypeCounts }),
    packageHash,
    validationHash,
    duplicateClassification: duplicateDetection.classification,
    publicationRequestBuilt,
  });
}

export function auditPresentationPayload(value, reference = 'presentation') {
  auditPresentationNode(value, reference, new Set());
  return true;
}

function validateMetadata(metadata, { validationOnly }) {
  if (!isPlainObject(metadata)) {
    fail('METADATA_INVALID');
  }

  requireStableIdentifier(metadata.examKey, 'EXAM_KEY_INVALID');
  requireStableIdentifier(metadata.packageSchemaVersion, 'PACKAGE_SCHEMA_VERSION_INVALID');
  requireStableIdentifier(metadata.validationContractVersion, 'VALIDATION_CONTRACT_VERSION_INVALID');
  requireStableIdentifier(metadata.generatorVersion, 'GENERATOR_VERSION_INVALID');
  requireStableIdentifier(metadata.scorerVersion, 'SCORER_VERSION_INVALID');

  if (!GIT_SHA_PATTERN.test(metadata.sourceCommitSha ?? '')) {
    fail('SOURCE_COMMIT_INVALID', metadata.examKey);
  }

  if (!validationOnly) {
    requireStableIdentifier(metadata.packageVersion, 'PACKAGE_VERSION_INVALID', metadata.examKey);
  } else if (metadata.packageVersion !== undefined && metadata.packageVersion !== null) {
    requireStableIdentifier(metadata.packageVersion, 'PACKAGE_VERSION_INVALID', metadata.examKey);
  }
}

function validateSourceRoot(source, expectedExamKey) {
  if (!isPlainObject(source)) {
    fail('SOURCE_INVALID', expectedExamKey);
  }

  try {
    canonicalSerialize(source);
  } catch {
    fail('SOURCE_NOT_JSON_SAFE', expectedExamKey);
  }

  if (source.examKey !== expectedExamKey) {
    fail('SOURCE_EXAM_KEY_MISMATCH', expectedExamKey);
  }
  if (!Array.isArray(source.questions) || source.questions.length === 0) {
    fail('QUESTION_COLLECTION_INVALID', expectedExamKey);
  }
  if (!Array.isArray(source.profiles) || source.profiles.length === 0) {
    fail('PROFILE_COLLECTION_INVALID', expectedExamKey);
  }
  if (!Array.isArray(source.supportedQuestionTypes) || source.supportedQuestionTypes.length === 0) {
    fail('SUPPORTED_TYPES_INVALID', expectedExamKey);
  }

}

function normalizeDomains(domains, examKey) {
  if (!Array.isArray(domains) || domains.length === 0) {
    fail('DOMAIN_COLLECTION_INVALID', examKey);
  }

  const aliasToId = new Map();
  const normalized = domains.map((domain) => {
    if (!isPlainObject(domain)) {
      fail('DOMAIN_INVALID', examKey);
    }

    requireStableIdentifier(domain.id, 'DOMAIN_ID_INVALID', examKey);
    requireNonEmptyString(domain.label ?? domain.name, 'DOMAIN_LABEL_INVALID', examKey, domain.id);

    const aliases = [domain.id, domain.label, domain.name, ...(domain.aliases ?? [])]
      .filter((value) => typeof value === 'string' && value.trim());

    for (const alias of aliases) {
      const existingId = aliasToId.get(alias);

      if (existingId && existingId !== domain.id) {
        fail('DOMAIN_ALIAS_CONFLICT', examKey, domain.id);
      }
      aliasToId.set(alias, domain.id);
    }

    return compactObject({
      domainKey: domain.id,
      label: domain.label ?? domain.name,
      targetWeight: domain.targetWeight,
    });
  });

  if (new Set(normalized.map(({ domainKey }) => domainKey)).size !== normalized.length) {
    fail('DUPLICATE_DOMAIN_ID', examKey);
  }

  return {
    domains: normalized,
    aliases: [...aliasToId.keys()],
    resolve(value, questionId) {
      const domainId = aliasToId.get(value);

      if (!domainId) {
        fail('QUESTION_DOMAIN_UNKNOWN', examKey, questionId);
      }

      return domainId;
    },
  };
}

function normalizeObjectiveContract(objectiveContract, examKey) {
  if (
    !isPlainObject(objectiveContract) ||
    !Array.isArray(objectiveContract.skillGroups) ||
    !Array.isArray(objectiveContract.subskills)
  ) {
    fail('OBJECTIVE_CONTRACT_INVALID', examKey);
  }

  const skillGroups = [...new Set(objectiveContract.skillGroups)];
  const subskills = [...new Set(objectiveContract.subskills)];

  skillGroups.forEach((value) => requireStableIdentifier(value, 'SKILL_GROUP_INVALID', examKey));
  subskills.forEach((value) => requireStableIdentifier(value, 'SUBSKILL_INVALID', examKey));

  return {
    skillGroups: new Set(skillGroups),
    subskills: new Set(subskills),
    normalized: {
      skillGroups: [...skillGroups].sort(),
      subskills: [...subskills].sort(),
    },
  };
}

function normalizeScoringContract(scoringContract, examKey) {
  if (!isPlainObject(scoringContract) || scoringContract.model !== 'standard-exact-v1') {
    fail('PACKAGE_SCORING_MODEL_UNSUPPORTED', examKey);
  }

  const minimum = Number(scoringContract.scoreScale?.min);
  const maximum = Number(scoringContract.scoreScale?.max);
  const passing = Number(scoringContract.scoreScale?.pass);

  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    !Number.isFinite(passing) ||
    minimum < 0 ||
    maximum <= minimum ||
    passing < minimum ||
    passing > maximum ||
    Number(scoringContract.passScoreOutOf1000) !== passing
  ) {
    fail('PACKAGE_SCORE_SCALE_INVALID', examKey);
  }

  return {
    model: scoringContract.model,
    passScoreOutOf1000: passing,
    scoreScale: { min: minimum, max: maximum, pass: passing },
  };
}

function normalizeQuestion({
  question,
  sourceOrdinal,
  examKey,
  domainContract,
  objectiveContract,
}) {
  const questionId = typeof question?.id === 'string' && question.id.trim()
    ? question.id.trim()
    : `index-${sourceOrdinal}`;

  try {
    canonicalSerialize(question);
  } catch {
    fail('QUESTION_NOT_JSON_SAFE', examKey, questionId);
  }

  if (!isPlainObject(question)) {
    fail('QUESTION_INVALID', examKey, questionId);
  }
  requireStableIdentifier(question.id, 'QUESTION_ID_INVALID', examKey, questionId);

  if (!SUPPORTED_TYPE_SET.has(question.type)) {
    if (question.type === 'case-study-info' || question.caseStudyId) {
      fail('CASE_STUDY_UNSUPPORTED', examKey, questionId);
    }
    if (typeof question.type === 'string' && question.type.startsWith('pbq-')) {
      fail('PBQ_UNSUPPORTED', examKey, questionId);
    }
    fail('QUESTION_TYPE_UNSUPPORTED', examKey, questionId);
  }

  rejectUnsupportedScoringFields(question, examKey, questionId);
  assertOnlyApprovedQuestionFields(question, examKey, questionId);
  requireNonEmptyString(question.question, 'QUESTION_PROMPT_EMPTY', examKey, questionId);
  requireNonEmptyString(question.explanation, 'QUESTION_EXPLANATION_MISSING', examKey, questionId);
  requireNonEmptyString(question.remediation, 'QUESTION_REMEDIATION_MISSING', examKey, questionId);

  if (!objectiveContract.skillGroups.has(question.officialSkillGroup)) {
    fail('QUESTION_SKILL_GROUP_UNKNOWN', examKey, questionId);
  }
  if (question.skillGroup !== question.officialSkillGroup) {
    fail('QUESTION_SKILL_GROUP_MISMATCH', examKey, questionId);
  }
  requireNonEmptyString(
    question.skillGroupLabel,
    'QUESTION_SKILL_GROUP_LABEL_INVALID',
    examKey,
    questionId,
  );
  if (!objectiveContract.subskills.has(question.ai901Subskill)) {
    fail('QUESTION_SUBSKILL_UNKNOWN', examKey, questionId);
  }
  if (
    !Array.isArray(question.topicTags) ||
    question.topicTags.some((tag) => typeof tag !== 'string' || !tag.trim()) ||
    !question.topicTags.includes(question.ai901Subskill)
  ) {
    fail('QUESTION_TOPIC_TAG_INVALID', examKey, questionId);
  }

  const domainKey = domainContract.resolve(question.domain, questionId);
  const typeContent = normalizeTypeContent(question, examKey, questionId);
  const presentationPayload = compactObject({
    prompt: question.question,
    difficulty: question.difficulty,
    objective: {
      skillGroup: question.officialSkillGroup,
      skillGroupLabel: question.skillGroupLabel,
      subskill: question.ai901Subskill,
      topicTags: [...question.topicTags],
    },
    ...typeContent.presentation,
  });

  auditPresentationPayload(presentationPayload, `${examKey}/${questionId}`);

  const scoringPayload = typeContent.scoring;
  const reviewPayload = {
    explanation: question.explanation,
    remediation: question.remediation,
  };
  const authoringMetadata = compactObject({
    betaBatch: question.betaBatch,
    betaSample: question.betaSample,
    qualityStatus: question.qualityStatus,
    productionHardeningPhase: question.productionHardeningPhase,
    remediationBatch: question.remediationBatch,
  });
  const contentHash = sha256Canonical({
    presentationPayload,
    scoringPayload,
    reviewPayload,
    authoringMetadata,
  });

  return {
    questionId: question.id,
    questionType: question.type,
    domainKey,
    sectionKey: question.officialSkillGroup,
    sourceOrdinal,
    presentationPayload,
    scoringPayload,
    reviewPayload,
    authoringMetadata,
    contentHash,
  };
}

function normalizeTypeContent(question, examKey, questionId) {
  if (question.type === 'single-choice') {
    const options = normalizeObjectOptions(question.options, examKey, questionId);
    assertReferences(options, [question.correctAnswer], examKey, questionId, 'CORRECT_OPTION_UNKNOWN');

    return {
      presentation: { options },
      scoring: { model: 'exact-single', correctOptionId: question.correctAnswer, maxPoints: 1 },
    };
  }

  if (question.type === 'multi-select') {
    const options = normalizeObjectOptions(question.options, examKey, questionId);

    if (
      !Array.isArray(question.correctAnswers) ||
      question.correctAnswers.length < 2 ||
      new Set(question.correctAnswers).size !== question.correctAnswers.length
    ) {
      fail('MULTI_SELECT_CARDINALITY_INVALID', examKey, questionId);
    }
    assertReferences(options, question.correctAnswers, examKey, questionId, 'CORRECT_OPTION_UNKNOWN');

    return {
      presentation: { options, requiredSelectionCount: question.correctAnswers.length },
      scoring: {
        model: 'exact-set',
        correctOptionIds: [...question.correctAnswers],
        requiredSelectionCount: question.correctAnswers.length,
        maxPoints: 1,
      },
    };
  }

  if (question.type === 'drag-drop-match') {
    const prompts = normalizeIdTextCollection(
      question.prompts,
      examKey,
      questionId,
      'PROMPT_COLLECTION_INVALID',
    );
    const options = normalizeObjectOptions(question.options, examKey, questionId);
    const correctPairs = question.correctPairs;

    if (!isPlainObject(correctPairs) || Object.keys(correctPairs).length !== prompts.length) {
      fail('MATCH_PAIR_CARDINALITY_INVALID', examKey, questionId);
    }

    const promptIds = new Set(prompts.map(({ id }) => id));
    const optionIds = new Set(options.map(({ id }) => id));

    for (const [promptId, optionId] of Object.entries(correctPairs)) {
      if (!promptIds.has(promptId) || !optionIds.has(optionId)) {
        fail('MATCH_REFERENCE_UNKNOWN', examKey, questionId);
      }
    }

    return {
      presentation: { prompts, options },
      scoring: { model: 'exact-pairs', correctPairs: { ...correctPairs }, maxPoints: 1 },
    };
  }

  if (question.type === 'reorder') {
    const items = normalizeIdTextCollection(
      question.items,
      examKey,
      questionId,
      'REORDER_ITEMS_INVALID',
    );
    const itemIds = new Set(items.map(({ id }) => id));

    if (
      !Array.isArray(question.correctOrder) ||
      question.correctOrder.length !== items.length ||
      new Set(question.correctOrder).size !== question.correctOrder.length ||
      question.correctOrder.some((itemId) => !itemIds.has(itemId))
    ) {
      fail('REORDER_CONTRACT_INVALID', examKey, questionId);
    }

    return {
      presentation: { items },
      scoring: { model: 'exact-order', correctItemIds: [...question.correctOrder], maxPoints: 1 },
    };
  }

  return normalizeDropdownContent(question, examKey, questionId);
}

function normalizeDropdownContent(question, examKey, questionId) {
  const templateField = question.type === 'dropdown-code'
    ? 'codeTemplate'
    : question.commandTemplate
      ? 'commandTemplate'
      : 'codeTemplate';

  requireNonEmptyString(question[templateField], 'DROPDOWN_TEMPLATE_INVALID', examKey, questionId);

  if (!Array.isArray(question.blanks) || question.blanks.length === 0) {
    fail('DROPDOWN_BLANKS_INVALID', examKey, questionId);
  }

  const seenBlankIds = new Set();
  const correctOptionIdsByBlank = {};
  const blanks = question.blanks.map((blank) => {
    if (!isPlainObject(blank)) {
      fail('DROPDOWN_BLANK_INVALID', examKey, questionId);
    }
    if (Object.keys(blank).some((key) => !['id', 'label', 'options', 'correctAnswer'].includes(key))) {
      fail('DROPDOWN_BLANK_FIELD_UNSUPPORTED', examKey, questionId, blank.id);
    }
    requireStableIdentifier(blank.id, 'DROPDOWN_BLANK_ID_INVALID', examKey, questionId);
    requireNonEmptyString(blank.label, 'DROPDOWN_BLANK_LABEL_INVALID', examKey, questionId, blank.id);
    if (seenBlankIds.has(blank.id)) {
      fail('DROPDOWN_BLANK_ID_DUPLICATE', examKey, questionId, blank.id);
    }
    seenBlankIds.add(blank.id);

    if (
      !Array.isArray(blank.options) ||
      blank.options.length === 0 ||
      blank.options.some((option) => typeof option !== 'string' || !option.trim()) ||
      new Set(blank.options).size !== blank.options.length
    ) {
      fail('DROPDOWN_OPTIONS_INVALID', examKey, questionId, blank.id);
    }

    const options = blank.options.map((text, index) => ({
      id: `${blank.id}-option-${index + 1}`,
      text,
    }));
    const correctIndex = blank.options.indexOf(blank.correctAnswer);

    if (correctIndex < 0) {
      fail('DROPDOWN_CORRECT_OPTION_UNKNOWN', examKey, questionId, blank.id);
    }
    correctOptionIdsByBlank[blank.id] = options[correctIndex].id;

    return { id: blank.id, label: blank.label, options };
  });

  return {
    presentation: {
      templateKind: templateField,
      template: question[templateField],
      blanks,
    },
    scoring: {
      model: 'exact-dropdowns',
      correctOptionIdsByBlank,
      maxPoints: 1,
    },
  };
}

function normalizeObjectOptions(options, examKey, questionId) {
  return normalizeIdTextCollection(
    options,
    examKey,
    questionId,
    'OPTION_COLLECTION_INVALID',
  );
}

function normalizeIdTextCollection(collection, examKey, questionId, errorCode) {
  if (!Array.isArray(collection) || collection.length === 0) {
    fail(errorCode, examKey, questionId);
  }

  const seenIds = new Set();

  return collection.map((item) => {
    if (!isPlainObject(item)) {
      fail(errorCode, examKey, questionId);
    }
    const itemKeys = Object.keys(item);
    if (itemKeys.some((key) => !['id', 'text'].includes(key))) {
      fail('PRESENTATION_ITEM_FIELD_UNSUPPORTED', examKey, questionId, item.id);
    }
    requireStableIdentifier(item.id, 'PRESENTATION_ITEM_ID_INVALID', examKey, questionId);
    requireNonEmptyString(item.text, 'PRESENTATION_ITEM_TEXT_INVALID', examKey, questionId, item.id);
    if (seenIds.has(item.id)) {
      fail('PRESENTATION_ITEM_ID_DUPLICATE', examKey, questionId, item.id);
    }
    seenIds.add(item.id);

    return { id: item.id, text: item.text };
  });
}

function assertReferences(options, references, examKey, questionId, errorCode) {
  const optionIds = new Set(options.map(({ id }) => id));

  if (!Array.isArray(references) || references.some((reference) => !optionIds.has(reference))) {
    fail(errorCode, examKey, questionId);
  }
}

function normalizeProfiles({
  profiles,
  examKey,
  questionCount,
  domainContract,
  scoringContract,
}) {
  const seenIds = new Set();

  return profiles.map((profile, index) => {
    const profileId = profile?.id ?? `index-${index + 1}`;

    if (!isPlainObject(profile)) {
      fail('PROFILE_INVALID', examKey, profileId);
    }
    requireStableIdentifier(profile.id, 'PROFILE_ID_INVALID', examKey, profileId);
    if (seenIds.has(profile.id)) {
      fail('PROFILE_ID_DUPLICATE', examKey, profile.id);
    }
    seenIds.add(profile.id);

    const displayName = profile.displayName ?? profile.label ?? profile.name;
    const requestedCount = Number(
      profile.standardQuestionCount ??
      profile.totalScoredQuestions ??
      profile.totalScoredItems,
    );
    const timeLimitMinutes = Number(profile.timeLimitMinutes ?? profile.minutes);

    requireNonEmptyString(displayName, 'PROFILE_DISPLAY_NAME_INVALID', examKey, profile.id);
    if (!Number.isInteger(requestedCount) || requestedCount <= 0 || requestedCount > questionCount) {
      fail('PROFILE_QUESTION_COUNT_INVALID', examKey, profile.id);
    }
    if (
      profile.totalScoredQuestions !== undefined &&
      Number(profile.totalScoredQuestions) !== requestedCount
    ) {
      fail('PROFILE_SCORED_COUNT_MISMATCH', examKey, profile.id);
    }
    if (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes <= 0) {
      fail('PROFILE_TIME_LIMIT_INVALID', examKey, profile.id);
    }
    if (
      Number(profile.pbqCount ?? 0) !== 0 ||
      Number(profile.caseStudyCount ?? 0) !== 0 ||
      Number(profile.longCaseStudyCount ?? 0) !== 0 ||
      Number(profile.shortCaseStudyCount ?? 0) !== 0
    ) {
      fail('PROFILE_NON_STANDARD_CONTENT_UNSUPPORTED', examKey, profile.id);
    }

    const domainDistribution = {};
    for (const [domainAlias, count] of Object.entries(profile.domainDistribution ?? {})) {
      const domainKey = domainContract.resolve(domainAlias, profile.id);
      if (!Number.isInteger(count) || count < 0) {
        fail('PROFILE_DOMAIN_COUNT_INVALID', examKey, profile.id, domainKey);
      }
      domainDistribution[domainKey] = count;
    }
    if (
      Object.keys(domainDistribution).length > 0 &&
      Object.values(domainDistribution).reduce((total, count) => total + count, 0) !== requestedCount
    ) {
      fail('PROFILE_DOMAIN_TOTAL_INVALID', examKey, profile.id);
    }

    return {
      profileKey: profile.id,
      displayName,
      questionCount: requestedCount,
      timeLimitMinutes,
      selectionConfig: compactObject({
        domainDistribution,
        officialSkillGroupTargets: profile.officialSkillGroupTargets,
        minimumTopicTagCounts: profile.minimumTopicTagCounts,
        scoringContract,
      }),
    };
  });
}

function buildPublicationRequest({
  metadata,
  packageContent,
  packageHash,
  validationHash,
  validationManifest,
  profiles,
  questions,
}) {
  return {
    ...(metadata.publicationRequestId ? { publicationRequestId: metadata.publicationRequestId } : {}),
    packageIdentity: {
      examKey: metadata.examKey,
      packageVersion: metadata.packageVersion,
      packageSchemaVersion: metadata.packageSchemaVersion,
      generatorVersion: metadata.generatorVersion,
      scorerVersion: metadata.scorerVersion,
    },
    sourceMetadata: {
      sourceCommitSha: metadata.sourceCommitSha,
    },
    packageMetadata: packageContent.exam,
    validationMetadata: {
      validationContractVersion: metadata.validationContractVersion,
      packageHash,
      validationHash,
      manifest: validationManifest,
    },
    packageProfiles: profiles,
    presentationQuestions: questions.map((question) => ({
      questionId: question.questionId,
      questionType: question.questionType,
      domainKey: question.domainKey,
      sectionKey: question.sectionKey,
      sourceOrdinal: question.sourceOrdinal,
      presentationPayload: question.presentationPayload,
      contentHash: question.contentHash,
    })),
    protectedQuestions: questions.map((question) => ({
      questionId: question.questionId,
      scoringPayload: question.scoringPayload,
      reviewPayload: question.reviewPayload,
      authoringMetadata: question.authoringMetadata,
    })),
  };
}

function validatePublicationIdentity(identity, reference) {
  if (!isPlainObject(identity)) {
    fail('PUBLICATION_IDENTITY_INVALID', reference);
  }
  requireStableIdentifier(identity.examKey, 'PUBLICATION_EXAM_KEY_INVALID', reference);
  requireStableIdentifier(identity.packageVersion, 'PUBLICATION_VERSION_INVALID', reference);
  if (!GIT_SHA_PATTERN.test(identity.sourceCommitSha ?? '')) {
    fail('PUBLICATION_SOURCE_COMMIT_INVALID', reference);
  }
  if (!HASH_PATTERN.test(identity.packageHash ?? '')) {
    fail('PUBLICATION_PACKAGE_HASH_INVALID', reference);
  }
  if (!HASH_PATTERN.test(identity.validationHash ?? '')) {
    fail('PUBLICATION_VALIDATION_HASH_INVALID', reference);
  }
}

function conflict(classification, matchedIndex) {
  return { classification, accepted: false, matchedIndex };
}

function auditPresentationNode(value, reference, activeObjects) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return;
  }
  if (typeof value !== 'object' || activeObjects.has(value)) {
    fail('PRESENTATION_STRUCTURE_INVALID', reference);
  }

  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item) => auditPresentationNode(item, reference, activeObjects));
      return;
    }
    if (!isPlainObject(value)) {
      fail('PRESENTATION_STRUCTURE_INVALID', reference);
    }

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (BLOCKED_PRESENTATION_KEYS.has(normalizedKey)) {
        fail('PROTECTED_KEY_IN_PRESENTATION', reference);
      }
      auditPresentationNode(child, reference, activeObjects);
    }
  } finally {
    activeObjects.delete(value);
  }
}

function assertOnlyApprovedQuestionFields(question, examKey, questionId) {
  const allowedFields = new Set([
    ...COMMON_QUESTION_FIELDS,
    ...(TYPE_FIELDS[question.type] ?? []),
  ]);
  const unsupportedField = Object.keys(question).find((field) => !allowedFields.has(field));

  if (unsupportedField) {
    fail('QUESTION_FIELD_UNSUPPORTED', examKey, questionId);
  }
}

function rejectUnsupportedScoringFields(question, examKey, questionId) {
  const unsupportedFields = [
    'scoringModel',
    'scoringRules',
    'partialCredit',
    'points',
    'maxPoints',
  ];

  if (unsupportedFields.some((field) => Object.hasOwn(question, field))) {
    fail('SCORING_MODEL_UNSUPPORTED', examKey, questionId);
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

function requireStableIdentifier(value, code, ...references) {
  if (typeof value !== 'string' || !value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    fail(code, ...references);
  }
}

function requireNonEmptyString(value, code, ...references) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(code, ...references);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code, ...references) {
  throw new PublicationValidationError(code, references);
}
