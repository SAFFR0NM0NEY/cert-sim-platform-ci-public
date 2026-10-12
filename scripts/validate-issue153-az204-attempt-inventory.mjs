import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';
import {
  assertProtectedAttemptInventory,
  getProtectedAttemptInventory,
  getProtectedItemSection,
} from '../src/lib/protectedAttemptInventory.js';
import { toPresentationQuestion } from '../src/lib/protectedExamContract.js';

const interactionTypes = [
  'single-choice', 'multi-select', 'reorder', 'drag-drop-match',
  'dropdown-code', 'dropdown-command',
];

function profile(examId, profileId) {
  const found = protectedProfileMetadata[examId]?.profiles.find((entry) => entry.id === profileId);
  assert.ok(found, `Missing profile metadata for ${examId}/${profileId}`);
  return found;
}

function buildItems({ standard, caseQuestions = 0, contexts = 0, pbqs = 0 }) {
  const caseStudyIds = Array.from({ length: Math.max(contexts, 1) }, (_, index) => `synthetic-workload-${index + 1}`);
  return [
    ...Array.from({ length: contexts }, (_, index) => ({
      type: 'case-study-info',
      caseStudyId: caseStudyIds[index],
      section: `workload-context-${index + 1}`,
    })),
    ...Array.from({ length: caseQuestions }, (_, index) => ({
      type: interactionTypes[index % interactionTypes.length],
      caseStudyId: caseStudyIds[index % caseStudyIds.length],
      section: `workload-${(index % caseStudyIds.length) + 1}`,
    })),
    ...Array.from({ length: standard }, (_, index) => ({
      type: interactionTypes[index % interactionTypes.length],
      section: 'standalone',
    })),
    ...Array.from({ length: pbqs }, (_, index) => ({
      type: index % 2 ? 'pbq-workspace' : 'pbq-siem',
      section: 'practical',
    })),
  ];
}

function legacyInventory(items) {
  const section = (item) => (
    item?.type === 'case-study-info' || /case/i.test(String(item?.section ?? ''))
      ? 'case-study'
      : String(item?.type ?? '').startsWith('pbq-') ? 'pbq' : 'standard'
  );
  const scored = items.filter((item) => item?.type !== 'case-study-info');
  return {
    totalScoredQuestions: scored.length,
    standardQuestionCount: scored.filter((item) => section(item) === 'standard').length,
    caseStudyQuestionCount: scored.filter((item) => section(item) === 'case-study').length,
    caseStudyCount: items.filter((item) => item?.type === 'case-study-info').length,
    pbqCount: scored.filter((item) => section(item) === 'pbq').length,
  };
}

const az204Matrix = [
  ['standard-profile', 43, 7, 1],
  ['compact-profile', 37, 3, 1],
  ['full-profile', 50, 10, 2],
  ['case-heavy-profile', 40, 10, 2],
];

for (const [profileId, standard, caseQuestions, contexts] of az204Matrix) {
  const items = buildItems({ standard, caseQuestions, contexts });
  const expected = profile('az204', profileId);
  assert.deepEqual(getProtectedAttemptInventory(items), {
    totalScoredQuestions: standard + caseQuestions,
    standardQuestionCount: standard,
    caseStudyQuestionCount: caseQuestions,
    caseStudyCount: contexts,
    pbqCount: 0,
  });
  assert.deepEqual(assertProtectedAttemptInventory(expected, items), getProtectedAttemptInventory(items));
}

for (const [profileId, standard, caseQuestions, contexts] of az204Matrix.slice(0, 2)) {
  const broken = legacyInventory(buildItems({ standard, caseQuestions, contexts }));
  assert.equal(broken.totalScoredQuestions, standard + caseQuestions, `${profileId} legacy total drifted`);
  assert.equal(broken.standardQuestionCount, standard + caseQuestions, `${profileId} legacy reproduction missing`);
  assert.equal(broken.caseStudyQuestionCount, 0, `${profileId} legacy reproduction missing`);
}

const standardProfile = profile('az204', 'standard-profile');
for (const [name, malformed] of [
  ['44 standard plus 6 case', buildItems({ standard: 44, caseQuestions: 6, contexts: 1 })],
  ['missing required context', buildItems({ standard: 43, caseQuestions: 7, contexts: 0 })],
  ['51 scored questions', buildItems({ standard: 44, caseQuestions: 7, contexts: 1 })],
  ['unexpected PBQ', buildItems({ standard: 42, caseQuestions: 7, contexts: 1, pbqs: 1 })],
]) {
  assert.throws(
    () => assertProtectedAttemptInventory(standardProfile, malformed),
    (error) => error?.code === 'attempt_inventory_mismatch',
    `${name} must fail closed`,
  );
}

assert.equal(getProtectedItemSection({ type: 'pbq-siem', caseStudyId: 'synthetic-workload-1' }), 'pbq');
assert.equal(getProtectedItemSection({ type: 'single-choice', caseStudyId: '  ' }), 'standard');
assert.equal(getProtectedItemSection({ type: 'single-choice', caseStudyId: 123 }), 'standard');
assert.equal(getProtectedItemSection({ type: 'single-choice', section: 'legacy-case-section' }), 'case-study');

const crossExamMatrix = [
  ['ai901', 'ai901-controlled-beta-full', buildItems({ standard: 50 })],
  ['inf303', 'inf303-standard', buildItems({ standard: 40 })],
  ['sc200', 'sc200-full', buildItems({ standard: 50 })],
  ['security-plus-sy0-701', 'strict-beta-full', buildItems({ standard: 86, pbqs: 4 })],
  ['az400', 'az400-sectioned-full-exam-profile', buildItems({ standard: 66, caseQuestions: 12, contexts: 2, pbqs: 2 })],
];
for (const [examId, profileId, items] of crossExamMatrix) {
  assertProtectedAttemptInventory(profile(examId, profileId), items);
}

const rawExistingAttempt = buildItems({ standard: 43, caseQuestions: 7, contexts: 1 }).map((item, index) => ({
  itemId: `synthetic-item-${index + 1}`,
  questionId: `synthetic-source-${index + 1}`,
  questionNumber: item.type === 'case-study-info' ? null : index + 1,
  questionType: item.type === 'case-study-info' ? 'case-study-context' : item.type,
  domain: 'synthetic-domain',
  section: item.section,
  response: null,
  revision: 0,
  presentation: {
    caseStudyId: item.caseStudyId,
    prompt: 'Synthetic safe prompt.',
  },
}));
const projectedExistingAttempt = rawExistingAttempt.map(toPresentationQuestion);
assertProtectedAttemptInventory(standardProfile, projectedExistingAttempt);
assert.equal(projectedExistingAttempt.filter((item) => item.caseStudyId).length, 8);

const runner = await readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
assert.match(runner, /map\(toPresentationQuestion\)[\s\S]*assertProtectedAttemptInventory/);
assert.match(runner, /attempt_inventory_mismatch|assertProtectedAttemptInventory/);

console.log(JSON.stringify({
  ok: true,
  issue: 153,
  az204Profiles: az204Matrix.map(([id]) => id),
  crossExamProfiles: crossExamMatrix.map(([examId, profileId]) => `${examId}/${profileId}`),
  legacyFailureReproduced: true,
  malformedCompositionsRejected: 4,
  inventoryGuardPreserved: true,
}));
