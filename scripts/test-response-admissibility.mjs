import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExamOperationsCandidate } from './backend-exam-publication/exam-operations-candidate.mjs';
import { RESPONSE_ADMISSIBILITY_CASES, responseCaseCandidate, mixedResponseCandidate } from './fixtures/response-admissibility.mjs';

const before = process.env.RESPONSE_CORRECTION_PHASE === 'before';
for (const entry of RESPONSE_ADMISSIBILITY_CASES) test(`${before ? 'original' : 'corrected'} normal preflight: ${entry.id}`, () => {
  const result = validateExamOperationsCandidate(responseCaseCandidate(entry));
  assert.equal(result.ok, before ? entry.beforeJs : entry.accepted, entry.id);
});
test('mixed four-family fixture has independent4/8 and5/10 maxima for all matching policies', () => {
  const result = validateExamOperationsCandidate(mixedResponseCandidate());
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.profiles.map(p => p.forms.perForm.map(f => [f.itemCount, f.rawMaximum])),
    [[[4,8],[5,10]],[[4,8],[5,10]],[[4,8],[5,10]]]);
});
