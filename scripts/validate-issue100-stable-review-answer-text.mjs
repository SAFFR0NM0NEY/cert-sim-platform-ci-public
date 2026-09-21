import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveReleasedChoiceTexts } from '../src/lib/releasedAnswerDisplay.js';

const options = [
  { id: 'stable-one', text: 'Use managed identity.' },
  { id: 'stable-two', text: 'Store a client secret.' },
  { id: 'stable-three', text: 'Use a shared access key.' },
  { id: 'stable-four', text: 'Allow anonymous access.' },
];
const shuffled = [options[3], options[1], options[0], options[2]];
const single = { type: 'single-choice', options: shuffled };
const select = { type: 'multi-select', options: shuffled };

assert.deepEqual(
  resolveReleasedChoiceTexts(single, { correctAnswer: 'stable-one' }, { correct: true }),
  { status: 'resolved', texts: ['Use managed identity.'] },
);
assert.deepEqual(
  resolveReleasedChoiceTexts(select, { correctAnswers: ['stable-one', 'stable-three'] }, { correct: true }).texts,
  ['Use managed identity.', 'Use a shared access key.'],
);
assert.deepEqual(
  resolveReleasedChoiceTexts({ ...select, options }, { correctOptionIds: ['stable-one', 'stable-three'] }, { correct: true }).texts,
  ['Use managed identity.', 'Use a shared access key.'],
);
assert.deepEqual(
  resolveReleasedChoiceTexts(select, { correctAnswers: ['stable-one', 'stable-three', 'stable-four'] }, { correct: true }).texts,
  ['Use managed identity.', 'Use a shared access key.', 'Allow anonymous access.'],
);

const savedResponse = JSON.parse(JSON.stringify({ answer: ['stable-one'] }));
for (const stage of ['save', 'navigate', 'refresh', 'resume', 'submit', 'review', 'history']) {
  assert.deepEqual(
    resolveReleasedChoiceTexts(select, savedResponse).texts,
    ['Use managed identity.'],
    `${stage} must retain the stable response identity`,
  );
}

assert.equal(resolveReleasedChoiceTexts(select, { correctAnswers: ['missing'] }, { correct: true }).status, 'invalid');
assert.equal(resolveReleasedChoiceTexts(select, { correctAnswers: ['stable-one', 'stable-one'] }, { correct: true }).status, 'invalid');
assert.equal(resolveReleasedChoiceTexts(select, { answer: [] }).status, 'invalid');
assert.equal(resolveReleasedChoiceTexts({ type: 'reorder', options }, {}, { correct: true }).status, 'not-applicable');

const runner = fs.readFileSync(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewWorkspace.jsx', import.meta.url), 'utf8');
const reviewAnswer = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewAnswer.jsx', import.meta.url), 'utf8');
const edgeResponses = fs.readFileSync(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
const edgeTests = fs.readFileSync(new URL('../supabase/functions/certsim-protected-exam/tests/function_test.ts', import.meta.url), 'utf8');
const partialScorer = fs.readFileSync(new URL('../supabase/tests/backend_exam_delivery_issue83_partial_scorer.sql', import.meta.url), 'utf8');

assert.match(workspace, /<ReleasedReviewAnswer presentation=\{item\.presentation\}/);
assert.match(reviewAnswer, /<ul className="released-answer-list">/);
assert.match(reviewAnswer, /resolveReleasedChoiceTexts\(presentation, value, options\)/);
assert.match(workspace, /questionType=\{item\.questionType\}/);
assert.doesNotMatch(workspace, /<dt>Correct answer<\/dt><dd>\{formatReviewValue/);
assert.match(runner, /reviewWithheld &&/);
assert.match(edgeResponses, /assertPracticeFeedbackSafe/);
assert.match(edgeTests, /correctAnswer: "blocked"/);
assert.match(partialScorer, /per-correct-option-no-negative-v1/);
assert.match(partialScorer, /correctAnswers/);

console.log('Issue #100 stable released-answer validation passed.');
