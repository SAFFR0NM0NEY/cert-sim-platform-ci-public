import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  deserializeProtectedResponse,
  getProtectedExamKey,
  getProtectedProfileKey,
  serializeProtectedResponse,
} from '../src/lib/protectedExamContract.js';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';

const sql = await readFile(new URL('../supabase/tests/backend_exam_delivery_issue127.sql', import.meta.url), 'utf8');
const issue124 = await readFile(new URL('../supabase/tests/backend_exam_delivery_issue124.sql', import.meta.url), 'utf8');
const integration = await readFile(new URL('./test-generic-protected-lifecycle-integration.mjs', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/backend-exam-delivery-db-validation.yml', import.meta.url), 'utf8');
const contract = await readFile(new URL('../src/lib/protectedExamContract.js', import.meta.url), 'utf8');
const edgeErrors = await readFile(new URL('../supabase/functions/certsim-protected-exam/errors.ts', import.meta.url), 'utf8');

const live = Object.freeze([
  ['ai901', 'ai901', '3.0.0', ['ai901-controlled-beta-compact', 'ai901-controlled-beta-full']],
  ['inf303', 'inf303', '1.1.0', ['inf303-standard', 'inf303-compact']],
  ['sc200', 'sc200', '1.1.0', ['sc200-full', 'sc200-compact']],
  ['az204', 'az204', '1.1.0', ['full-profile', 'compact-profile', 'standard-profile', 'case-heavy-profile']],
  ['security-plus-sy0-701', 'securityplussy0701', '1.0.0', ['strict-beta-full', 'strict-beta-compact']],
  ['az400', 'az400', '1.0.0', ['az400-mvp-full-profile', 'az400-mvp-compact-profile', 'az400-sectioned-full-exam-profile']],
]);

for (const [frontendId, examKey, version, profiles] of live) {
  assert.equal(getProtectedExamKey(frontendId), examKey, `${frontendId} runtime identity drifted`);
  for (const profile of profiles) assert.equal(getProtectedProfileKey(frontendId, profile), profile);
  const metadata = protectedProfileMetadata[frontendId];
  assert.ok(metadata, `${frontendId} safe metadata missing`);
  assert.equal(metadata.packageVersion, version, `${frontendId} active package version drifted`);
}

const roundTrips = [
  [{ type: 'single-choice' }, 'a', { answer: 'a' }],
  [{ type: 'multi-select' }, ['a', 'b'], { answer: ['a', 'b'] }],
  [{ type: 'reorder' }, ['b', 'a'], { answer: ['b', 'a'] }],
  [{ type: 'drag-drop-match' }, { s: 't' }, { answer: { s: 't' } }],
  [{ type: 'dropdown-code' }, { b: 'o' }, { answer: { b: 'o' } }],
  [{ type: 'dropdown-command' }, { b: 'o' }, { answer: { b: 'o' } }],
  [{ type: 'true-false-single-v1' }, true, { answer: true }],
  [{ type: 'true-false-composite-v1' }, { s1: true, empty: '' }, { answer: { s1: true } }],
  [{ type: 'matching-v1' }, { s1: 't1', empty: '' }, { answer: { s1: 't1' } }],
  [{ type: 'code-dropdown-completion-v1' }, { b1: 'o1', empty: '' }, { answer: { b1: 'o1' } }],
  [{ type: 'pbq-ordering', responseAllowlist: { orderIds: ['a', 'b'] } }, ['a', 'b'], { selectedOrder: ['a', 'b'] }],
  [{ type: 'pbq-terminal', responseAllowlist: { answerIds: ['a'], commandIds: ['run'] } }, { selectedAnswer: 'a', executedCommands: ['run'], commandHistory: ['browser-only display'] }, { selectedAnswer: 'a', executedCommands: ['run'] }],
  [{ type: 'pbq-config-panel', responseAllowlist: { targetIds: ['t'], answerIdsByTarget: { t: ['a'] } } }, { selectedAnswers: { t: 'a' } }, { selectedAnswers: { t: 'a' } }],
];

for (const [question, answer, expected] of roundTrips) {
  const serialized = serializeProtectedResponse(question, answer);
  assert.deepEqual(serialized, expected, `${question.type} serialization drifted`);
  assert.deepEqual(deserializeProtectedResponse(question, serialized),
    question.type === 'pbq-terminal' ? { selectedAnswer: 'a', executedCommands: ['run'] } :
      question.type === 'pbq-config-panel' ? { t: 'a' } :
        question.type.includes('composite') || question.type === 'matching-v1' || question.type === 'code-dropdown-completion-v1'
          ? expected.answer : answer,
    `${question.type} deserialization drifted`);
}
assert.equal(serializeProtectedResponse({ type: 'case-study-info' }, undefined), null);
assert.equal(serializeProtectedResponse({ type: 'informational' }, undefined), null);

for (const family of [
  'single-choice', 'multi-select', 'reorder', 'drag-drop-match', 'dropdown-code', 'dropdown-command',
  'true-false-single-v1', 'true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1',
  'selectedAnswer', 'selectedOrder', 'selectedAnswers', 'executedCommands', 'case-study-context', 'informational',
]) assert.ok(sql.includes(family), `Issue #127 pgTAP omits ${family}`);

for (const scorer of [
  'package_v2_response_valid', 'score_package_v2_response', 'score_package_v2_response_with_presentation',
  'score_selected_response_partial', 'score_package_v2_response_for_scorer',
]) assert.ok(sql.includes(scorer), `Issue #127 pgTAP omits ${scorer}`);

assert.match(issue124, /multi-select accepts allowed identifiers/);
assert.match(issue124, /reorder accepts an allowed sequence/);
assert.match(integration, /ARRAY_RESPONSE_MULTI_SELECT_FIXTURE_MISSING/);
assert.match(integration, /ARRAY_RESPONSE_REORDER_FIXTURE_MISSING/);
assert.match(integration, /GENERIC_RESPONSE_REPLAY_FAILED/);
assert.match(workflow, /backend_exam_delivery_issue124\.sql \\\r?\n\s+backend_exam_delivery_issue127\.sql \\\r?\n\s+backend_exam_delivery_issue147\.sql \\\r?\n\s+backend_exam_delivery_issue160\.sql \\\r?\n\s+backend_exam_delivery_issue167\.sql\r?\n\s+do/,
  'Issue #127 pgTAP must be connected to the continued database suite list');

assert.match(contract, /normalizeKeyedStructuredAnswer/);
assert.match(contract, /selectedAnswer.*selectedAnswers.*selectedOrder.*executedCommands/s);
assert.match(edgeErrors, /invalid_response/);
assert.match(edgeErrors, /stale_response/);
assert.match(edgeErrors, /stale_response:\s*409/);
assert.match(edgeErrors, /invalid_response:\s*"invalid_request"/);

console.log('Issue #127 cross-exam protected response/save contracts validated.');
