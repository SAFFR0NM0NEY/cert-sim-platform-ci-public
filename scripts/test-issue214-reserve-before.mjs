import assert from 'node:assert/strict';
import { reserveCandidate } from './fixtures/issue214-reserves.mjs';
import { validateExamOperationsCandidate, EXAM_OPERATIONS_VALIDATOR_VERSION } from './backend-exam-publication/exam-operations-candidate.mjs';
const result = validateExamOperationsCandidate(reserveCandidate());
assert.equal(result.ok, false);
assert.deepEqual(result.validation.errors.map(e => e.code), ['CANONICAL_FORM_CROSS_PROFILE_RESERVE_MISMATCH']);
console.log(JSON.stringify({ suite: 'issue214-before', validator: EXAM_OPERATIONS_VALIDATOR_VERSION, expectedRejection: 'CANONICAL_FORM_CROSS_PROFILE_RESERVE_MISMATCH', profiles: 2, syntheticOnly: true }));
