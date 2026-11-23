import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalSerialize,
  sha256Canonical,
} from './backend-exam-publication/canonical-json.mjs';
import {
  PROTECTED_PACKAGE_SCHEMA_VERSION,
  PROTECTED_VALIDATION_CONTRACT_VERSION,
  PROTECTED_GENERATOR_VERSION,
  PROTECTED_SCORER_VERSION,
  PublicationValidationError,
  auditPresentationPayload,
  classifyPublicationIdentity,
  prepareProtectedPublication,
} from './backend-exam-publication/publication-model.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);
const HASH_C = '3'.repeat(64);
const tests = [];

test('canonical object keys ignore insertion order', () => {
  const left = { zebra: 1, alpha: { second: 2, first: 1 } };
  const right = { alpha: { first: 1, second: 2 }, zebra: 1 };

  assert.equal(canonicalSerialize(left), canonicalSerialize(right));
  assert.equal(sha256Canonical(left), sha256Canonical(right));
});

test('canonical arrays preserve order', () => {
  assert.notEqual(sha256Canonical(['a', 'b']), sha256Canonical(['b', 'a']));
});

test('canonical serializer rejects ambiguous JavaScript values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'value';
  class CustomValue {}

  for (const unsupported of [
    undefined,
    () => true,
    Symbol('value'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    new Date('2026-01-01T00:00:00Z'),
    new CustomValue(),
    sparse,
    cyclic,
  ]) {
    assert.throws(() => canonicalSerialize(unsupported), TypeError);
  }
});

test('presentation, protected, array, and validator changes own the correct hashes', () => {
  const baseline = buildSynthetic();
  const reorderedSource = clone(baseline.source);
  reorderedSource.questions.reverse();
  const presentationSource = clone(baseline.source);
  presentationSource.questions[0].question = 'Changed synthetic prompt.';
  const protectedAnswerSource = clone(baseline.source);
  protectedAnswerSource.questions[0].correctAnswer = 'b';
  const protectedReviewSource = clone(baseline.source);
  protectedReviewSource.questions[0].explanation = 'Changed synthetic explanation.';

  for (const changedSource of [
    reorderedSource,
    presentationSource,
    protectedAnswerSource,
    protectedReviewSource,
  ]) {
    const changed = buildSynthetic({ source: changedSource });
    assert.notEqual(changed.packageHash, baseline.packageHash);
  }

  const changedValidator = buildSynthetic({
    metadata: {
      ...baseline.metadata,
      validationContractVersion: 'synthetic-validator-v2',
    },
  });
  assert.equal(changedValidator.packageHash, baseline.packageHash);
  assert.notEqual(changedValidator.validationHash, baseline.validationHash);

  const changedCommit = buildSynthetic({
    metadata: { ...baseline.metadata, sourceCommitSha: SHA_B },
  });
  assert.equal(changedCommit.packageHash, baseline.packageHash);
  assert.equal(changedCommit.validationHash, baseline.validationHash);

  const changedPackageVersion = buildSynthetic({
    metadata: { ...baseline.metadata, packageVersion: '2.0.0-test' },
  });
  assert.equal(changedPackageVersion.packageHash, baseline.packageHash);
  assert.equal(changedPackageVersion.validationHash, baseline.validationHash);
});

test('valid single-select and multi-select fixtures build split records', () => {
  const result = buildSynthetic();

  assert.equal(result.publicationRequest.presentationQuestions.length, 2);
  assert.equal(result.publicationRequest.protectedQuestions.length, 2);
  assert.match(result.packageHash, /^[0-9a-f]{64}$/);
  assert.match(result.validationHash, /^[0-9a-f]{64}$/);
});

for (const [name, mutate, expectedCode] of [
  [
    'duplicate question id',
    (source) => { source.questions[1].id = source.questions[0].id; },
    'QUESTION_ID_DUPLICATE',
  ],
  [
    'duplicate option id',
    (source) => { source.questions[0].options[1].id = source.questions[0].options[0].id; },
    'PRESENTATION_ITEM_ID_DUPLICATE',
  ],
  [
    'missing option collection',
    (source) => { source.questions[0].options = []; },
    'OPTION_COLLECTION_INVALID',
  ],
  [
    'invalid correct option reference',
    (source) => { source.questions[0].correctAnswer = 'missing'; },
    'CORRECT_OPTION_UNKNOWN',
  ],
  [
    'incorrect multi-select cardinality',
    (source) => { source.questions[1].correctAnswers = ['a']; },
    'MULTI_SELECT_CARDINALITY_INVALID',
  ],
  [
    'empty prompt',
    (source) => { source.questions[0].question = '   '; },
    'QUESTION_PROMPT_EMPTY',
  ],
  [
    'unsupported PBQ',
    (source) => {
      source.questions = [{ ...source.questions[0], id: 'fixture-pbq-001', type: 'pbq-terminal' }];
      source.supportedQuestionTypes = ['pbq-terminal'];
      source.profiles[0].standardQuestionCount = 1;
      source.profiles[0].totalScoredQuestions = 1;
      source.profiles[0].domainDistribution = { 'Domain One': 1 };
    },
    'PBQ_UNSUPPORTED',
  ],
  [
    'unsupported case study',
    (source) => {
      source.questions = [{ ...source.questions[0], id: 'fixture-case-001', type: 'case-study-info' }];
      source.supportedQuestionTypes = ['case-study-info'];
      source.profiles[0].standardQuestionCount = 1;
      source.profiles[0].totalScoredQuestions = 1;
      source.profiles[0].domainDistribution = { 'Domain One': 1 };
    },
    'CASE_STUDY_UNSUPPORTED',
  ],
  [
    'unsupported scoring model',
    (source) => { source.questions[0].scoringModel = 'partial-credit'; },
    'SCORING_MODEL_UNSUPPORTED',
  ],
  [
    'malformed JSON-shaped metadata',
    (source) => { source.questions[0].betaSample = new Date('2026-01-01T00:00:00Z'); },
    'SOURCE_NOT_JSON_SAFE',
  ],
]) {
  test(`validation rejects ${name}`, () => {
    const source = createSyntheticSource();
    mutate(source);

    assert.throws(
      () => buildSynthetic({ source }),
      (error) => error instanceof PublicationValidationError && error.code === expectedCode,
    );
  });
}

test('presentation audit recursively rejects protected keys without scanning text', () => {
  assert.equal(
    auditPresentationPayload({
      prompt: 'Which answer is correct? Explain the scenario.',
      nested: [{ label: 'Correct operation wording is allowed in text.' }],
    }),
    true,
  );
  assert.throws(
    () => auditPresentationPayload({ nested: { correctAnswer: 'not-safe' } }, 'fixture-question-001'),
    (error) => error.code === 'PROTECTED_KEY_IN_PRESENTATION',
  );
});

test('presentation records exclude protected keys and protected records retain review/scoring', () => {
  const result = buildSynthetic();
  const presentationText = JSON.stringify(result.publicationRequest.presentationQuestions);
  const protectedText = JSON.stringify(result.publicationRequest.protectedQuestions);

  assert.doesNotMatch(presentationText, /correctAnswer|explanation|remediation|scoringPayload/);
  assert.match(protectedText, /correctOptionId/);
  assert.match(protectedText, /explanation/);
  assert.match(protectedText, /remediation/);
});

test('sanitized summary and validation errors reveal no protected content', () => {
  const result = buildSynthetic();
  const summaryText = JSON.stringify(result.summary);
  const protectedSourceValues = [
    'Synthetic prompt one.',
    'Synthetic option alpha.',
    'Synthetic explanation one.',
    'Synthetic remediation one.',
  ];

  protectedSourceValues.forEach((value) => assert.equal(summaryText.includes(value), false));

  const invalidSource = createSyntheticSource();
  invalidSource.questions[0].question = 'CONFIDENTIAL PROMPT VALUE';
  invalidSource.questions[0].correctAnswer = 'CONFIDENTIAL ANSWER VALUE';

  try {
    buildSynthetic({ source: invalidSource });
    assert.fail('Expected invalid correct-answer reference to fail.');
  } catch (error) {
    assert.equal(error.message.includes('CONFIDENTIAL PROMPT VALUE'), false);
    assert.equal(error.message.includes('CONFIDENTIAL ANSWER VALUE'), false);
    assert.match(error.message, /synthetic-exam\/fixture-single-001/);
  }
});

test('pure preparation emits no console output and writes no request', () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args);

  try {
    buildSynthetic();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(messages, []);
});

test('duplicate and conflict classifier covers all approved outcomes', () => {
  const candidate = identity();

  assert.equal(classifyPublicationIdentity(candidate, []).classification, 'new_candidate');
  assert.equal(
    classifyPublicationIdentity(candidate, [identity()]).classification,
    'idempotent_duplicate',
  );
  assert.equal(
    classifyPublicationIdentity(candidate, [identity({ packageHash: HASH_B })]).classification,
    'version_conflict',
  );
  assert.equal(
    classifyPublicationIdentity(candidate, [identity({ validationHash: HASH_C })]).classification,
    'validation_conflict',
  );
  assert.equal(
    classifyPublicationIdentity(candidate, [identity({ sourceCommitSha: SHA_B })]).classification,
    'source_identity_conflict',
  );
  assert.equal(
    classifyPublicationIdentity(candidate, [identity({ packageVersion: '2.0.0' })]).classification,
    'duplicate_content',
  );
  assert.equal(
    classifyPublicationIdentity(candidate, [identity({
      packageVersion: '2.0.0',
      packageHash: HASH_B,
    })]).classification,
    'source_package_conflict',
  );
});

test('conflicting publication metadata fails closed without building a request', () => {
  const conflict = prepareProtectedPublication({
    source: createSyntheticSource(),
    metadata: createMetadata(),
    existingPublications: [identity({ packageHash: HASH_C })],
  });

  assert.equal(conflict.duplicateDetection.classification, 'version_conflict');
  assert.equal(conflict.duplicateDetection.accepted, false);
  assert.equal(conflict.publicationRequest, null);
  assert.equal(conflict.summary.publicationRequestBuilt, false);
});

test('offline publication tooling contains no transport, Supabase, secret, or disk-output code', async () => {
  const files = [
    ...(await listModuleFiles(path.join(projectRoot, 'scripts', 'backend-exam-publication'))),
    path.join(projectRoot, 'scripts', 'validate-backend-exam-publication.mjs'),
  ];
  const forbiddenPatterns = [
    /\bfetch\s*\(/,
    /createClient\s*\(/,
    /SUPABASE_(?:URL|KEY|SECRET|SERVICE)/,
    new RegExp(['service', 'role'].join('_'), 'i'),
    /\bwriteFile(?:Sync)?\s*\(/,
    /\bappendFile(?:Sync)?\s*\(/,
    /https?:\/\//,
  ];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    forbiddenPatterns.forEach((pattern) => {
      assert.doesNotMatch(source, pattern, `${path.basename(file)} contains ${pattern}.`);
    });
  }
});

for (const { name, callback } of tests) {
  try {
    await callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(`  - ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\nPublication tooling validation passed (${tests.length} deterministic tests).`);

function test(name, callback) {
  tests.push({ name, callback });
}

function buildSynthetic({ source = createSyntheticSource(), metadata } = {}) {
  const resolvedMetadata = metadata ?? createMetadata();
  const result = prepareProtectedPublication({
    source,
    metadata: resolvedMetadata,
    existingPublications: [],
  });

  return { ...result, source, metadata: resolvedMetadata };
}

function createMetadata() {
  return {
    examKey: 'synthetic-exam',
    packageVersion: '1.0.0-test',
    sourceCommitSha: SHA_A,
    packageSchemaVersion: PROTECTED_PACKAGE_SCHEMA_VERSION,
    validationContractVersion: PROTECTED_VALIDATION_CONTRACT_VERSION,
    generatorVersion: PROTECTED_GENERATOR_VERSION,
    scorerVersion: PROTECTED_SCORER_VERSION,
  };
}

function createSyntheticSource() {
  return {
    examKey: 'synthetic-exam',
    supportedQuestionTypes: ['single-choice', 'multi-select'],
    domains: [
      {
        id: 'domain-one',
        label: 'Domain One',
        targetWeight: 100,
        aliases: ['Domain One'],
      },
    ],
    objectiveContract: {
      skillGroups: ['skill-group-one'],
      subskills: ['subskill-one'],
    },
    scoringContract: {
      model: 'standard-exact-v1',
      passScoreOutOf1000: 700,
      scoreScale: { min: 0, max: 1000, pass: 700 },
    },
    profiles: [
      {
        id: 'fixture-profile',
        displayName: 'Fixture Profile',
        totalScoredQuestions: 2,
        standardQuestionCount: 2,
        timeLimitMinutes: 10,
        pbqCount: 0,
        caseStudyCount: 0,
        domainDistribution: { 'Domain One': 2 },
      },
    ],
    questions: [
      {
        id: 'fixture-single-001',
        type: 'single-choice',
        domain: 'Domain One',
        difficulty: 'medium',
        question: 'Synthetic prompt one.',
        options: [
          { id: 'a', text: 'Synthetic option alpha.' },
          { id: 'b', text: 'Synthetic option beta.' },
        ],
        correctAnswer: 'a',
        explanation: 'Synthetic explanation one.',
        remediation: 'Synthetic remediation one.',
        officialSkillGroup: 'skill-group-one',
        skillGroup: 'skill-group-one',
        skillGroupLabel: 'Skill Group One',
        ai901Subskill: 'subskill-one',
        topicTags: ['subskill-one'],
      },
      {
        id: 'fixture-multi-001',
        type: 'multi-select',
        domain: 'Domain One',
        difficulty: 'hard',
        question: 'Select 2 synthetic options.',
        options: [
          { id: 'a', text: 'Synthetic first option.' },
          { id: 'b', text: 'Synthetic second option.' },
          { id: 'c', text: 'Synthetic third option.' },
        ],
        correctAnswers: ['a', 'b'],
        explanation: 'Synthetic explanation two.',
        remediation: 'Synthetic remediation two.',
        officialSkillGroup: 'skill-group-one',
        skillGroup: 'skill-group-one',
        skillGroupLabel: 'Skill Group One',
        ai901Subskill: 'subskill-one',
        topicTags: ['subskill-one'],
      },
    ],
    requireMultiSelectCountHint: true,
  };
}

function identity(overrides = {}) {
  return {
    examKey: 'synthetic-exam',
    packageVersion: '1.0.0-test',
    sourceCommitSha: SHA_A,
    packageHash: HASH_A,
    validationHash: HASH_B,
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

async function listModuleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => path.join(directory, entry.name));
}
