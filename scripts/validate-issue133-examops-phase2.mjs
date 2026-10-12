import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import {
  EXAM_OPERATIONS_MANIFEST_SCHEMA,
  MIGRATION_CLASSIFICATIONS,
  assertSanitizedManifest,
  formatExamOperationsValidationReport,
  validateExamOperationsCandidate,
} from './backend-exam-publication/exam-operations-candidate.mjs';
import {
  CAPABILITY_COMPATIBILITY_REGISTRY,
  compareRegistryCapabilitySets,
  validatePackageCapabilityRegistryDrift,
} from './backend-exam-publication/exam-operations-capability-registry.mjs';
import {
  PROTECTED_PRESENTATION_TYPES,
} from '../src/lib/protectedExamContract.js';

const tests = [];

test('normal standard selected-response package passes', () => {
  const result = validate(candidate());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.inventory.scoredItemCount, 2);
  assert.equal(result.manifest.profiles[0].composition.standardQuestionCount, 2);
});

test('mixed case-study, standard, and PBQ package passes', () => {
  const result = validate(mixedCandidate());
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.profiles[0].composition, {
    standardQuestionCount: 3,
    caseStudyCount: 1,
    caseStudyQuestionCount: 2,
    pbqCount: 1,
    executableCount: 0,
  });
});

test('fixed canonical forms produce only aggregate form evidence', () => {
  const result = validate(fixedFormsCandidate());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.profiles[0].selectionClassification, 'fixed');
  assert.equal(result.manifest.profiles[0].forms.formCount, 2);
  assert.equal(result.manifest.profiles[0].forms.membershipHashes.length, 2);
  assert.equal(JSON.stringify(result.manifest).includes('fixed-q-1'), false);
});

test('structured partial-scoring package passes', () => {
  const fixture = candidate({
    capabilities: ['matching-v1'],
    questions: [matchingQuestion('matching-1')],
    profile: { questionCount: 1, selection: { standardQuestionCount: 1, sectionOrder: 'standard' } },
    runtime: pythonStandardRuntime(),
  });
  const result = validate(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.inventory.byInteractionType[0].key, 'matching-v1');
});

test('executable Python package passes with trusted executor tuple', () => {
  const result = validate(executableCandidate());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.inventory.executableLabItemCount, 1);
  assert.equal(result.manifest.runtime.executorRequirement.provider, 'modal');
});

test('all existing PBQ families are registered and compatible', () => {
  const fixture = pbqCandidate();
  const result = validate(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.inventory.pbqItemCount, 10);
  assert.equal(result.manifest.capabilities.filter((value) => value.startsWith('pbq-')).length, 10);
});

test('unsupported question capability requires capability review', () => {
  const fixture = candidate({
    capabilities: ['quantum-lab-v1'],
    questions: [standardQuestion('unknown-1', { type: 'quantum-lab-v1' })],
    profile: { questionCount: 1, selection: { standardQuestionCount: 1 } },
  });
  const result = validateExamOperationsCandidate(fixture);
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
  assert.equal(result.compatibility.overall, 'review_required');
});

test('unsupported scorer requires platform capability review', () => {
  const fixture = candidate();
  fixture.runtime.scorerVersion = 'unregistered-scorer-v1';
  const result = validateExamOperationsCandidate(fixture);
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
  assert.ok(result.compatibility.reasons.includes('RUNTIME_TUPLE_UNSUPPORTED'));
});

test('unsupported generator/runtime tuple requires platform capability review', () => {
  const fixture = candidate();
  fixture.runtime.generatorVersion = 'unregistered-generator-v1';
  const result = validateExamOperationsCandidate(fixture);
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
  assert.equal(result.compatibility.runtime, 'unsupported');
});

test('unsupported executor requirement is distinguished from a known tuple', () => {
  const fixture = executableCandidate();
  fixture.runtime = pythonStandardRuntime();
  const result = validateExamOperationsCandidate(fixture);
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
  assert.ok(result.compatibility.reasons.includes('EXECUTOR_REQUIREMENT_UNSUPPORTED'));
});

test('malformed profile totals fail before publication', () => {
  const fixture = candidate();
  fixture.profiles[0].selection.standardQuestionCount = 1;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'PROFILE_COMPOSITION_INCONSISTENT');
});

test('case-study count contradiction fails', () => {
  const fixture = mixedCandidate();
  fixture.profiles[0].selection.caseStudyQuestionCount = 1;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'CASE_STUDY_SELECTION_IMPOSSIBLE');
});

test('PBQ count contradiction fails', () => {
  const fixture = mixedCandidate();
  fixture.profiles[0].selection.pbqCount = 2;
  fixture.profiles[0].selection.standardQuestionCount = 2;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'PBQ_COUNT_CONTRADICTION');
});

test('executable count contradiction fails', () => {
  const fixture = executableCandidate();
  fixture.profiles[0].selection.executableCount = 2;
  fixture.profiles[0].selection.standardQuestionCount = 0;
  fixture.profiles[0].questionCount = 2;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'EXECUTABLE_COUNT_CONTRADICTION');
});

test('section order requiring unavailable section fails', () => {
  const fixture = candidate();
  fixture.profiles[0].selection.sectionOrder = 'pbq-standard';
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'SECTION_ORDER_INVALID');
});

test('canonical form membership count mismatch fails', () => {
  const fixture = fixedFormsCandidate();
  fixture.profiles[0].selection.canonicalForms.forms[0].questionIds.pop();
  fixture.profiles[0].selection.canonicalForms.forms[0].membershipHash = sha256Canonical(
    fixture.profiles[0].selection.canonicalForms.forms[0].questionIds,
  );
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'CANONICAL_FORM_DEFINITION_INVALID');
});

test('reserve insufficiency fails the fixed-form union contract', () => {
  const fixture = fixedFormsCandidate();
  fixture.profiles[0].selection.canonicalForms.reserveQuestionIds = [];
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'CANONICAL_FORM_RESERVE_INSUFFICIENT');
});

test('duplicate question identity fails without echoing the identity', () => {
  const fixture = candidate();
  fixture.questions[1].id = fixture.questions[0].id;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'QUESTION_ID_DUPLICATE');
  assert.equal(JSON.stringify(result.validation).includes(fixture.questions[0].id), false);
});

test('duplicate profile and form identities fail', () => {
  const fixture = fixedFormsCandidate();
  fixture.profiles.push(structuredClone(fixture.profiles[0]));
  fixture.profiles[0].selection.canonicalForms.forms[1].formKey =
    fixture.profiles[0].selection.canonicalForms.forms[0].formKey;
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'PROFILE_KEY_DUPLICATE');
  assertInvalid(result, 'CANONICAL_FORM_DEFINITION_INVALID');
});

test('manifest generation and all verdicts are deterministic', () => {
  const fixture = correctedAz400Candidate();
  const first = validateExamOperationsCandidate(fixture, successorContext());
  const second = validateExamOperationsCandidate(structuredClone(fixture), successorContext());
  assert.equal(first.canonicalManifest, second.canonicalManifest);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.deepEqual(first.validation, second.validation);
  assert.deepEqual(first.compatibility, second.compatibility);
});

test('manifest excludes protected fields and protected fixture values', () => {
  const fixture = candidate();
  fixture.questions[0].presentation.prompt = 'PROTECTED FIXTURE PROMPT MUST NOT LEAK';
  fixture.questions[0].privateScoring.secret = 'PROTECTED FIXTURE KEY MUST NOT LEAK';
  fixture.questions[0].privateReview.explanation = 'PROTECTED FIXTURE REVIEW MUST NOT LEAK';
  const result = validate(fixture);
  const serialized = JSON.stringify(result.manifest);
  for (const prohibited of [
    'PROTECTED FIXTURE PROMPT MUST NOT LEAK',
    'PROTECTED FIXTURE KEY MUST NOT LEAK',
    'PROTECTED FIXTURE REVIEW MUST NOT LEAK',
    '"prompt"', '"stem"', '"correctAnswer"', '"answerKey"', '"rubric"',
    '"scoringRules"', '"hiddenTests"', '"modelSolution"',
  ]) assert.equal(serialized.includes(prohibited), false, `manifest leaked ${prohibited}`);
  assert.doesNotThrow(() => assertSanitizedManifest(result.manifest));
  assert.throws(
    () => assertSanitizedManifest({ scoringRules: ['must not enter'] }),
    /MANIFEST_PROTECTED_FIELD_REJECTED/,
  );

  const hostileMetadata = candidate();
  hostileMetadata.exam.languagePreferences = [
    'csharp', 'python', 'mixed', 'PROTECTED LANGUAGE SENTINEL',
  ];
  hostileMetadata.profiles[0].selection.sectionOrder = [
    'standard', 'PROTECTED SECTION SENTINEL',
  ];
  const hostileResult = validateExamOperationsCandidate(hostileMetadata);
  const hostileManifest = JSON.stringify(hostileResult.manifest);
  assert.equal(hostileManifest.includes('PROTECTED LANGUAGE SENTINEL'), false);
  assert.equal(hostileManifest.includes('PROTECTED SECTION SENTINEL'), false);
  assert.ok(hostileResult.manifest.languageCapabilities.includes('invalid'));
  assert.ok(hostileResult.manifest.profiles[0].sectionOrder.includes('invalid'));
});

test('declared language variants require both supported payloads', () => {
  const fixture = candidate();
  fixture.exam.languagePreferences = ['csharp', 'python', 'mixed'];
  fixture.questions[0].group = {
    languageVariants: { csharp: { language: 'csharp' } },
  };
  const result = validateExamOperationsCandidate(fixture);
  assertInvalid(result, 'LANGUAGE_VARIANT_REQUIRED');
});

test('ordinary v2 successor is content release with no migration expected', () => {
  const result = validateExamOperationsCandidate(candidate(), successorContext());
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.contentRelease);
  assert.equal(result.compatibility.historicalCompatibility, 'supported');
});

test('new interaction capability is classified as a capability change', () => {
  const fixture = candidate({
    capabilities: ['future-interaction-v1'],
    questions: [standardQuestion('future-1', { type: 'future-interaction-v1' })],
    profile: { questionCount: 1, selection: { standardQuestionCount: 1 } },
  });
  const result = validateExamOperationsCandidate(fixture, successorContext());
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.capabilityChange);
});

test('AI-901 package v1 remains on the legacy path', () => {
  const result = validateExamOperationsCandidate({
    packageSchemaVersion: 'certsim-protected-package-v1',
    exam: { examKey: 'ai901', packageVersion: '1.0.0' },
  });
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.legacy);
  assert.equal(result.manifest, null);
});

test('ordinary v2 successor preserves historical compatibility classification', () => {
  const result = validateExamOperationsCandidate(candidate(), successorContext());
  assert.equal(result.compatibility.historicalCompatibility, 'supported');
  assert.equal(result.manifest.compatibility.cutoverPreflightRequired, true);
});

test('current AZ-400 sanitized contradiction is rejected safely', () => {
  const result = validateExamOperationsCandidate(brokenAz400Candidate(), successorContext());
  assertInvalid(result, 'PROFILE_COMPOSITION_INCONSISTENT');
  assert.equal(result.validation.verdict, 'invalid');
  assert.equal(JSON.stringify(result.validation).includes('az400-standard-'), false);
});

test('corrected AZ-400 66+12+2 composition is accepted as a content successor', () => {
  const result = validateExamOperationsCandidate(correctedAz400Candidate(), successorContext());
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.profiles[0].composition, {
    standardQuestionCount: 66,
    caseStudyCount: 2,
    caseStudyQuestionCount: 12,
    pbqCount: 2,
    executableCount: 0,
  });
  assert.equal(result.migrationClassification, MIGRATION_CLASSIFICATIONS.contentRelease);
});

test('capability registry matches package and frontend machine-readable declarations', () => {
  assert.equal(validatePackageCapabilityRegistryDrift().matches, true);
  assert.equal(compareRegistryCapabilitySets(PROTECTED_PRESENTATION_TYPES).matches, true);
  assert.equal(Object.keys(CAPABILITY_COMPATIBILITY_REGISTRY).length, 23);
});

test('human report is sanitized and covers the operator questions', () => {
  const result = validateExamOperationsCandidate(correctedAz400Candidate(), successorContext());
  const report = formatExamOperationsValidationReport(result);
  for (const label of [
    'Exam:', 'Candidate version:', 'Predecessor/current version:', 'Schema:',
    'Question inventory:', 'Interaction inventory:', 'Profiles:', 'Forms:',
    'Runtime compatibility:', 'Review compatibility:', 'Migration classification:',
    'Validation:', 'Warnings:',
  ]) assert.match(report, new RegExp(label));
  assert.doesNotMatch(report, /Sanitized fixture prompt|correctOptionIds|privateScoring/);
});

test('CLI and documentation preserve the validation-only boundary', async () => {
  const [packageJson, cli, docs] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('scripts/validate-exam-operations-candidate.mjs', 'utf8'),
    readFile('docs/CERTSIM_EXAM_OPERATIONS_PHASE2.md', 'utf8'),
  ]);
  assert.match(packageJson, /examops:validate-candidate/);
  assert.match(cli, /networkRequests:\s*0/);
  assert.match(cli, /productionMutations:\s*0/);
  assert.doesNotMatch(cli, /createClient|publishProtectedPackage|certsim_protected_publish_package/);
  assert.match(docs, /active-attempt continuation/i);
  assert.match(docs, /Phase 3/);
  assert.match(docs, /Phase 4/);
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

if (process.exitCode) process.exit(process.exitCode);
console.log(`\nIssue #133 Phase 2 validation passed (${tests.length} deterministic tests).`);

function test(name, callback) {
  tests.push({ name, callback });
}

function validate(fixture) {
  const result = validateExamOperationsCandidate(fixture, successorContext());
  assert.equal(result.validation.verdict, 'valid', JSON.stringify(result.validation));
  return result;
}

function assertInvalid(result, code) {
  assert.equal(result.validation.verdict, 'invalid');
  assert.ok(result.validation.errors.some((error) => error.code === code),
    `missing ${code}: ${JSON.stringify(result.validation.errors)}`);
}

function successorContext() {
  return { currentPackageVersion: '1.0.0', predecessorPackageVersion: '1.0.0' };
}

function candidate({
  capabilities = ['single-choice'],
  questions = [standardQuestion('standard-1'), standardQuestion('standard-2')],
  profile = {},
  runtime = standardRuntime(),
} = {}) {
  return {
    packageSchemaVersion: 'certsim-protected-package-v2',
    validationContractVersion: 'certsim-protected-multi-exam-validation-v1',
    exam: {
      examKey: 'synthetic100',
      packageVersion: '2.0.0',
      capabilities,
      domains: [{ key: 'domain-a', name: 'Sanitized domain' }],
    },
    source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
    runtime,
    profiles: [{
      profileKey: 'full-profile',
      displayName: 'Full',
      questionCount: 2,
      timeLimitMinutes: 30,
      selection: { standardQuestionCount: 2, sectionOrder: 'standard' },
      ...profile,
    }],
    releasePolicy: { review: 'after_submission', answers: 'after_submission' },
    questions,
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
      prompt: `Sanitized fixture prompt for ${id}.`,
      options: [{ id: 'a', text: 'Sanitized option A' }, { id: 'b', text: 'Sanitized option B' }],
    },
    privateScoring: { correctOptionIds: ['a'], maximumRawPoints: 1 },
    privateReview: { rationale: 'Private synthetic review.' },
    ...overrides,
  };
}

function matchingQuestion(id) {
  return {
    id,
    type: 'matching-v1',
    domainKey: 'domain-a',
    sectionKey: 'objective-a',
    scored: true,
    presentation: {
      interactionVersion: 'matching-v1',
      sources: [{ id: 'source-a', text: 'Source A' }],
      targets: [{ id: 'target-a', text: 'Target A' }],
    },
    privateScoring: {
      correctTargetIdsBySource: { 'source-a': 'target-a' },
      maximumRawPoints: 1,
    },
    privateReview: { rationale: 'Private synthetic review.' },
  };
}

function contextQuestion(id, groupKey, groupSize = 'short') {
  return {
    id,
    type: 'case-study-context',
    domainKey: 'domain-a',
    scored: false,
    group: { groupKey, groupSize, role: 'context', order: 0 },
    presentation: { heading: 'Sanitized case context.' },
    privateReview: {},
  };
}

function caseChild(id, groupKey, order, groupSize = 'short') {
  return standardQuestion(id, {
    group: { groupKey, groupSize, role: 'question', order },
  });
}

function pbqQuestion(id, type = 'pbq-config-panel') {
  return standardQuestion(id, {
    type,
    presentation: { interactionVersion: type, responseAllowlist: {} },
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
      starterCode: '# sanitized fixture',
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
    privateReview: { rationale: 'Private synthetic review.' },
  };
}

function mixedCandidate() {
  const questions = [
    standardQuestion('mixed-standard-1'),
    standardQuestion('mixed-standard-2'),
    standardQuestion('mixed-standard-3'),
    contextQuestion('mixed-context-1', 'mixed-case-1'),
    caseChild('mixed-child-1', 'mixed-case-1', 1),
    caseChild('mixed-child-2', 'mixed-case-1', 2),
    pbqQuestion('mixed-pbq-1'),
  ];
  return candidate({
    capabilities: ['single-choice', 'case-study-context', 'pbq-config-panel'],
    questions,
    profile: {
      questionCount: 6,
      timeLimitMinutes: 60,
      selection: {
        standardQuestionCount: 3,
        caseStudyCount: 1,
        caseStudyQuestionCount: 2,
        pbqCount: 1,
        sectionOrder: 'case-standard-pbq',
      },
    },
    runtime: az400Runtime(),
  });
}

function fixedFormsCandidate() {
  const questions = Array.from({ length: 5 }, (_, index) => standardQuestion(`fixed-q-${index + 1}`));
  const formOneIds = ['fixed-q-1', 'fixed-q-2'];
  const formTwoIds = ['fixed-q-3', 'fixed-q-4'];
  const canonicalForms = {
    contractVersion: 'certsim-python-standard-forms-v1',
    cycleLength: 2,
    reservePolicy: 'profile-specific-reserve',
    reserveQuestionIds: ['fixed-q-5'],
    forms: [
      { formKey: 'form-a', ordinal: 1, questionIds: formOneIds, membershipHash: sha256Canonical(formOneIds), rawMaximum: 2 },
      { formKey: 'form-b', ordinal: 2, questionIds: formTwoIds, membershipHash: sha256Canonical(formTwoIds), rawMaximum: 2 },
    ],
  };
  return candidate({
    questions,
    profile: {
      questionCount: 2,
      selection: { canonicalForms },
    },
    runtime: pythonStandardRuntime(),
  });
}

function executableCandidate() {
  return candidate({
    capabilities: ['executable-python-lab-v1'],
    questions: [executableQuestion('python-lab-1')],
    profile: {
      questionCount: 1,
      selection: {
        standardQuestionCount: 0,
        executableCount: 1,
        sectionOrder: 'executable',
      },
    },
    runtime: pythonNextGenerationRuntime(),
  });
}

function pbqCandidate() {
  const types = [
    'pbq-terminal', 'pbq-multi-host-terminal', 'pbq-firewall', 'pbq-siem',
    'pbq-network-diagram', 'pbq-config-panel', 'pbq-hotspot',
    'pbq-drag-drop-match', 'pbq-ordering', 'pbq-workspace',
  ];
  return candidate({
    capabilities: types,
    questions: types.map((type, index) => pbqQuestion(`pbq-${index + 1}`, type)),
    profile: {
      questionCount: 10,
      selection: { standardQuestionCount: 0, pbqCount: 10, sectionOrder: 'pbq' },
    },
    runtime: securityPlusRuntime(),
  });
}

function brokenAz400Candidate() {
  const fixture = az400Candidate();
  fixture.profiles[0].selection.normalScoredQuestionCount = null;
  return fixture;
}

function correctedAz400Candidate() {
  const fixture = az400Candidate();
  fixture.profiles[0].selection.normalScoredQuestionCount = 66;
  return fixture;
}

function az400Candidate() {
  const standard = Array.from({ length: 66 }, (_, index) => (
    standardQuestion(`az400-standard-${index + 1}`)
  ));
  const cases = [];
  for (let caseIndex = 1; caseIndex <= 2; caseIndex += 1) {
    const key = `az400-case-${caseIndex}`;
    cases.push(contextQuestion(`az400-context-${caseIndex}`, key, 'long'));
    for (let child = 1; child <= 6; child += 1) {
      cases.push(caseChild(`az400-case-${caseIndex}-child-${child}`, key, child, 'long'));
    }
  }
  const questions = [
    ...standard,
    ...cases,
    pbqQuestion('az400-pbq-1'),
    pbqQuestion('az400-pbq-2'),
  ];
  const fixture = candidate({
    capabilities: ['single-choice', 'case-study-context', 'pbq-config-panel'],
    questions,
    profile: {
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
    },
    runtime: az400Runtime(),
  });
  fixture.exam.examKey = 'az400';
  fixture.exam.packageVersion = '1.1.0';
  return fixture;
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

function securityPlusRuntime() {
  return {
    generatorVersion: 'certsim-security-plus-pbq-first-generator-v1',
    scorerVersion: 'certsim-security-plus-authoritative-pbq-scorer-v1',
    pbqRuntimeVersion: 'certsim-protected-pbq-runtime-v1',
  };
}

function pythonStandardRuntime() {
  return {
    generatorVersion: 'certsim-python-standard-canonical-forms-v1',
    scorerVersion: 'certsim-versioned-structured-partial-v1',
  };
}

function pythonNextGenerationRuntime() {
  return {
    generatorVersion: 'certsim-python-next-generation-canonical-forms-v1',
    scorerVersion: 'certsim-python-trusted-grading-v1',
  };
}
