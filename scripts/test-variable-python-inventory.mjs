import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProtectedAttemptInventory } from '../src/lib/protectedAttemptInventory.js';
function fixture(n) {
  const items = Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, sourceQuestionId: `question-${i}`, type: 'true-false-composite-v1', questionNumber: i+1 }));
  const countContract = { version: 'certsim-authorised-form-count-v1', mode: 'variable', exactCount: n, allowedCounts: [3,5],
    composition: { standardQuestionCount: n, caseStudyCount: 0, caseStudyQuestionCount: 0, pbqCount: 0, executableCount: 0 },
    bindings: items.map(q => ({ itemId: q.id, questionId: q.sourceQuestionId, questionType: q.type, questionNumber: q.questionNumber })) };
  return { items, attempt: { countContract } };
}
for (const n of [3,5]) test(`validates ${n} against selected immutable binding instead of profile maximum`, () => {
  const f = fixture(n);
  assert.equal(assertProtectedAttemptInventory({ totalScoredQuestions: 5 }, f.items, f.attempt).totalScoredQuestions, n);
});
const mutations = {
  missing: f => f.items.pop(), extra: f => f.items.push({ ...f.items[0], id: 'extra' }),
  duplicate: f => { f.items[1] = { ...f.items[0] }; },
  'same count wrong member': f => { f.items[0].sourceQuestionId = 'wrong'; },
  'same count wrong item': f => { f.items[0].id = 'wrong'; },
  position: f => { f.items[0].questionNumber = 2; },
  response: f => { f.items[0].type = 'matching-v1'; },
  'missing exact metadata': f => { delete f.attempt.countContract; },
  'unknown metadata': f => { f.attempt.countContract.version = 'unknown'; },
  'range only': f => { delete f.attempt.countContract.exactCount; },
  'wrong exact count within range': f => { f.attempt.countContract.exactCount = 5; },
  'dishonest composition': f => { f.attempt.countContract.composition.pbqCount = 1; },
};
for (const [label, mutate] of Object.entries(mutations)) test(`fails closed for ${label}`, () => {
  const f = fixture(3); mutate(f);
  assert.throws(() => assertProtectedAttemptInventory({ countPolicy: { version: 'certsim-authorised-form-count-v1' } }, f.items, f.attempt), { code: 'attempt_inventory_mismatch' });
});
test('legacy fixed check still rejects missing items', () => {
  assert.throws(() => assertProtectedAttemptInventory({ totalScoredQuestions: 5 }, fixture(3).items), { code: 'attempt_inventory_mismatch' });
});
