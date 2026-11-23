import { canonicalSerialize, sha256Canonical } from './canonical-json.mjs';

export const MULTI_EXAM_PACKAGE_SCHEMA_VERSION = 'certsim-protected-package-v2';
export const MULTI_EXAM_VALIDATION_CONTRACT_VERSION =
  'certsim-protected-multi-exam-validation-v1';

export const MULTI_EXAM_QUESTION_CAPABILITIES = Object.freeze([
  'single-choice',
  'multi-select',
  'reorder',
  'drag-drop-match',
  'dropdown-code',
  'dropdown-command',
  'true-false-single-v1',
  'true-false-composite-v1',
  'matching-v1',
  'code-dropdown-completion-v1',
  'case-study-context',
  'informational',
  'pbq-terminal',
  'pbq-multi-host-terminal',
  'pbq-firewall',
  'pbq-siem',
  'pbq-network-diagram',
  'pbq-config-panel',
  'pbq-hotspot',
  'pbq-drag-drop-match',
  'pbq-ordering',
  'pbq-workspace',
  'executable-python-lab-v1',
]);

export const ACCESS_POLICY_MODES = Object.freeze([
  'open_authenticated',
  'assignment_required',
  'organisation_scoped',
  'controlled_beta',
  'disabled',
]);

const CAPABILITIES = new Set(MULTI_EXAM_QUESTION_CAPABILITIES);
const RELEASE_POLICIES = new Set(['never', 'after_submission', 'scheduled']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BLOCKED_PRESENTATION_KEYS = new Set([
  'answer', 'answers', 'correctanswer', 'correctanswers', 'correctorder',
  'correctpairs', 'expectedactions', 'explanation', 'partialcredit',
  'remediation', 'rubric', 'score', 'scoring', 'scoringrules',
  'correctvalue', 'correctvaluesbystatement', 'correcttargetidsbysource',
  'correctoptionidsbyblank', 'pointsbyblank', 'maximumrawpoints', 'modelsolution',
]);

export function normalizeExamKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function validateMultiExamPackageContract(contract) {
  requireObject(contract, 'PACKAGE_CONTRACT_INVALID');
  requireExactVersion(contract.packageSchemaVersion, MULTI_EXAM_PACKAGE_SCHEMA_VERSION);
  requireExactVersion(
    contract.validationContractVersion,
    MULTI_EXAM_VALIDATION_CONTRACT_VERSION,
  );

  const examKey = normalizeExamKey(contract.exam?.examKey);
  if (!examKey) fail('EXAM_KEY_INVALID');
  requireVersion(contract.exam?.packageVersion, 'PACKAGE_VERSION_INVALID');
  requireHash(contract.source?.sourceHash, 'SOURCE_HASH_INVALID');
  requireHash(contract.source?.validationHash, 'VALIDATION_HASH_INVALID');
  requireVersion(contract.runtime?.generatorVersion, 'GENERATOR_VERSION_INVALID');
  requireVersion(contract.runtime?.scorerVersion, 'SCORER_VERSION_INVALID');

  const capabilities = uniqueStrings(contract.exam?.capabilities);
  if (capabilities.length === 0 || capabilities.some((item) => !CAPABILITIES.has(item))) {
    fail('CAPABILITY_DECLARATION_INVALID');
  }
  const languagePreferences = uniqueStrings(contract.exam?.languagePreferences ?? []);
  if (languagePreferences.some((item) => !['csharp', 'python', 'mixed'].includes(item)) ||
      (languagePreferences.length > 0 && !['csharp', 'python', 'mixed'].every((item) => languagePreferences.includes(item)))) {
    fail('LANGUAGE_PREFERENCE_DECLARATION_INVALID');
  }
  validateProfiles(contract.profiles);
  validateDomains(contract.exam?.domains);
  validateReleasePolicy(contract.releasePolicy);
  validateQuestionRecords(contract.questions, capabilities);

  const manifest = {
    packageSchemaVersion: contract.packageSchemaVersion,
    validationContractVersion: contract.validationContractVersion,
    exam: {
      examKey,
      packageVersion: contract.exam.packageVersion,
      capabilities: [...capabilities].sort(),
      domains: contract.exam.domains,
      ...(languagePreferences.length ? { languagePreferences } : {}),
    },
    runtime: contract.runtime,
    profiles: contract.profiles,
    releasePolicy: contract.releasePolicy,
    questionCount: contract.questions.length,
  };

  return Object.freeze({
    examKey,
    packageVersion: contract.exam.packageVersion,
    questionCount: contract.questions.length,
    profileCount: contract.profiles.length,
    capabilities: [...capabilities].sort(),
    contractHash: sha256Canonical(manifest),
  });
}

export function assertPresentationPayloadSafe(value, reference = 'presentation') {
  walk(value, reference);
  return true;
}

export function createSanitizedMultiExamSummary(contract) {
  const result = validateMultiExamPackageContract(contract);
  return {
    ok: true,
    examKey: result.examKey,
    packageVersion: result.packageVersion,
    profileCount: result.profileCount,
    questionCount: result.questionCount,
    capabilities: result.capabilities,
    contractHash: result.contractHash,
  };
}

function validateProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) fail('PROFILES_INVALID');
  const keys = new Set();
  for (const profile of profiles) {
    requireObject(profile, 'PROFILE_INVALID');
    requireVersion(profile.profileKey, 'PROFILE_KEY_INVALID');
    if (keys.has(profile.profileKey)) fail('PROFILE_KEY_DUPLICATE');
    keys.add(profile.profileKey);
    if (!Number.isInteger(profile.questionCount) || profile.questionCount < 1) {
      fail('PROFILE_QUESTION_COUNT_INVALID');
    }
    if (!Number.isInteger(profile.timeLimitMinutes) || profile.timeLimitMinutes < 1) {
      fail('PROFILE_TIME_LIMIT_INVALID');
    }
    requireObject(profile.selection, 'PROFILE_SELECTION_INVALID');
  }
}

function validateDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) fail('DOMAINS_INVALID');
  const keys = new Set();
  for (const domain of domains) {
    requireObject(domain, 'DOMAIN_INVALID');
    requireVersion(domain.key, 'DOMAIN_KEY_INVALID');
    if (keys.has(domain.key)) fail('DOMAIN_KEY_DUPLICATE');
    keys.add(domain.key);
    if (typeof domain.name !== 'string' || !domain.name.trim()) fail('DOMAIN_NAME_INVALID');
  }
}

function validateReleasePolicy(policy) {
  requireObject(policy, 'RELEASE_POLICY_INVALID');
  if (!RELEASE_POLICIES.has(policy.review) || !RELEASE_POLICIES.has(policy.answers)) {
    fail('RELEASE_POLICY_INVALID');
  }
}

function validateQuestionRecords(questions, capabilities) {
  if (!Array.isArray(questions) || questions.length === 0) fail('QUESTIONS_INVALID');
  const ids = new Set();
  for (const record of questions) {
    requireObject(record, 'QUESTION_RECORD_INVALID');
    requireVersion(record.id, 'QUESTION_ID_INVALID');
    if (ids.has(record.id)) fail('QUESTION_ID_DUPLICATE');
    ids.add(record.id);
    if (!capabilities.includes(record.type)) fail('QUESTION_CAPABILITY_UNDECLARED');
    if (typeof record.domainKey !== 'string' || !record.domainKey) fail('QUESTION_DOMAIN_INVALID');
    if (record.scored !== false) {
      requireObject(record.privateScoring, 'PRIVATE_SCORING_REQUIRED');
    }
    requireObject(record.presentation, 'PRESENTATION_REQUIRED');
    requireObject(record.privateReview, 'PRIVATE_REVIEW_REQUIRED');
    assertPresentationPayloadSafe(record.presentation, record.id);
    validateVersionedInteraction(record);
  }
}

function validateVersionedInteraction(record) {
  const { presentation, privateScoring } = record;
  if (record.type === 'true-false-single-v1') {
    if (presentation.interactionVersion !== record.type || typeof presentation.statementId !== 'string' || typeof privateScoring.correctValue !== 'boolean' || privateScoring.maximumRawPoints !== 1) fail('TRUE_FALSE_SINGLE_INVALID');
  } else if (record.type === 'true-false-composite-v1') {
    validatePublicItems(presentation.statements, 'COMPOSITE_STATEMENTS_INVALID');
    validateExactMap(privateScoring.correctValuesByStatement, presentation.statements, (value) => typeof value === 'boolean', 'COMPOSITE_SCORING_INVALID');
    if (privateScoring.maximumRawPoints !== presentation.statements.length) fail('COMPOSITE_RAW_MAXIMUM_INVALID');
  } else if (record.type === 'matching-v1') {
    validatePublicItems(presentation.sources, 'MATCHING_SOURCES_INVALID'); validatePublicItems(presentation.targets, 'MATCHING_TARGETS_INVALID');
    const targetIds = new Set(presentation.targets.map(({ id }) => id));
    validateExactMap(privateScoring.correctTargetIdsBySource, presentation.sources, (value) => targetIds.has(value), 'MATCHING_SCORING_INVALID');
    if (privateScoring.maximumRawPoints !== presentation.sources.length) fail('MATCHING_RAW_MAXIMUM_INVALID');
  } else if (record.type === 'code-dropdown-completion-v1') {
    if (presentation.interactionVersion !== record.type || typeof presentation.codeTemplate !== 'string' || !presentation.codeTemplate || !Array.isArray(presentation.blanks) || !presentation.blanks.length) fail('DROPDOWN_PRESENTATION_INVALID');
    presentation.blanks.forEach((blank) => validatePublicItems(blank.options, 'DROPDOWN_OPTIONS_INVALID'));
    validateExactMap(privateScoring.correctOptionIdsByBlank, presentation.blanks, (value, blank) => blank.options.some(({ id }) => id === value), 'DROPDOWN_SCORING_INVALID');
    const maximum = presentation.blanks.reduce((sum, blank) => sum + Number(privateScoring.pointsByBlank?.[blank.id] ?? 0), 0);
    if (maximum <= 0 || maximum !== privateScoring.maximumRawPoints) fail('DROPDOWN_RAW_MAXIMUM_INVALID');
  } else if (record.type === 'executable-python-lab-v1') {
    validateExecutablePythonScoring(record);
  }
}

function validateExecutablePythonScoring(record) {
  const { presentation, privateScoring } = record;
  if (presentation.interactionVersion !== record.type || presentation.language !== 'python' ||
      typeof presentation.starterCode !== 'string' || !presentation.starterCode ||
      !Array.isArray(presentation.editableFiles) || !presentation.editableFiles.length ||
      !privateScoring || Object.keys(privateScoring).sort().join(',') !== 'maximumRawPoints,trustedGrading' ||
      !Number.isSafeInteger(privateScoring.maximumRawPoints) || privateScoring.maximumRawPoints < 1) {
    fail('EXECUTABLE_PYTHON_SCORING_INVALID');
  }
  const trusted = privateScoring.trustedGrading;
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted) ||
      Object.keys(trusted).sort().join(',') !== 'gradingMaterial,materialDigest,status' ||
      trusted.status !== 'compiled' || !HASH_PATTERN.test(trusted.materialDigest)) {
    fail('EXECUTABLE_PYTHON_SCORING_INVALID');
  }
  const material = trusted.gradingMaterial;
  if (!material || typeof material !== 'object' || Array.isArray(material) ||
      Object.keys(material).sort().join(',') !== 'contractVersion,maximumRawPoints,rules,taskId' ||
      material.contractVersion !== 'certsim-python-trusted-grading-v1' ||
      material.maximumRawPoints !== privateScoring.maximumRawPoints ||
      typeof material.taskId !== 'string' || !material.taskId ||
      !Array.isArray(material.rules) || material.rules.length < 1 || material.rules.length > 128) {
    fail('EXECUTABLE_PYTHON_SCORING_INVALID');
  }
  if (sha256Canonical(material) !== trusted.materialDigest) {
    fail('EXECUTABLE_PYTHON_SCORING_INVALID');
  }
}

function validatePublicItems(items, code) {
  if (!Array.isArray(items) || !items.length || new Set(items.map(({ id }) => id)).size !== items.length || items.some((item) => !item || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text)) fail(code);
}

function validateExactMap(map, items, valueValid, code) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== items.length || items.some((item) => !Object.hasOwn(map, item.id) || !valueValid(map[item.id], item))) fail(code);
}

function walk(value, reference) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${reference}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_PRESENTATION_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      fail('PROTECTED_FIELD_IN_PRESENTATION', reference, key);
    }
    walk(entry, `${reference}.${key}`);
  }
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function requireHash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail(code);
}

function requireVersion(value, code) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) fail(code);
}

function requireExactVersion(value, expected) {
  if (value !== expected) fail('CONTRACT_VERSION_UNSUPPORTED');
}

function requireObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
}

function fail(code, ...references) {
  throw new Error(`${code}${references.length ? ` [${references.join('/')}]` : ''}`);
}

export function canonicalizeMultiExamContract(contract) {
  validateMultiExamPackageContract(contract);
  return canonicalSerialize(contract);
}
