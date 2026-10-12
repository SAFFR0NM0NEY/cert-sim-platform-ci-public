import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  deserializeProtectedResponse,
  serializeProtectedResponse,
} from '../src/lib/protectedExamContract.js';
import { validateAndCanonicalizePBQResponse } from './backend-exam-publication/pbq-runtime.mjs';

const responseAllowlist = {
  targetIds: ['evidenceTargetA', 'decisionTargetA'],
  answerIdsByTarget: [
    { targetId: 'evidenceTargetA', answerIds: ['inspected'] },
    { targetId: 'decisionTargetA', answerIds: ['optionA', 'optionB'] },
  ],
  commandIds: ['inspect-host-a'],
};
const question = { type: 'pbq-multi-host-terminal', responseAllowlist };
const definition = { responseAllowlist };
const validates = (response) => validateAndCanonicalizePBQResponse(definition, response).value;

// A. Decision-only state is projected through the presentation allowlist.
const decisionOnly = serializeProtectedResponse(question, { decisionTargetA: 'optionA' });
assert.deepEqual(decisionOnly, { selectedAnswers: { decisionTargetA: 'optionA' } });
assert.deepEqual(validates(decisionOnly), decisionOnly);

// B/E. Scorer-authorized evidence and decisions survive; browser terminal state never does.
const evidenceAndDecision = serializeProtectedResponse(question, {
  evidenceTargetA: 'inspected',
  decisionTargetA: 'optionB',
  perHostCommandHistory: { hostA: ['inspect host a'] },
  perHostTerminalTranscript: {
    hostA: [{ id: 'browser-timestamp', command: 'inspect host a', output: 'browser-only output' }],
  },
});
assert.deepEqual(evidenceAndDecision, {
  selectedAnswers: { evidenceTargetA: 'inspected', decisionTargetA: 'optionB' },
});
assert.deepEqual(validates(evidenceAndDecision), evidenceAndDecision);
assert.doesNotMatch(JSON.stringify(evidenceAndDecision), /perHostCommandHistory|perHostTerminalTranscript|browser-only/);
assert.equal(Object.hasOwn(evidenceAndDecision, 'executedCommands'), false);

// C/D. Unknown targets and values fail before a protected request can be sent.
assert.throws(
  () => serializeProtectedResponse(question, { foreignTarget: 'optionA' }),
  /invalid_multi_host_response_target/,
);
assert.throws(
  () => serializeProtectedResponse(question, { decisionTargetA: 'foreignOption' }),
  /invalid_multi_host_response_value/,
);
assert.throws(
  () => serializeProtectedResponse(question, { extraBrowserState: { nested: true } }),
  /invalid_multi_host_response_target/,
);
assert.throws(
  () => serializeProtectedResponse({ type: question.type }, { decisionTargetA: 'optionA' }),
  /invalid_multi_host_response_allowlist/,
);

// Empty select values represent a cleared selection, not a scorer value.
assert.deepEqual(
  serializeProtectedResponse(question, { decisionTargetA: '' }),
  { selectedAnswers: {} },
);

// Explicit canonical command IDs remain future-compatible and fail closed.
const withCanonicalCommand = serializeProtectedResponse(question, {
  decisionTargetA: 'optionA',
  executedCommands: ['inspect-host-a'],
  perHostCommandHistory: { hostA: ['display text is not a command ID'] },
});
assert.deepEqual(withCanonicalCommand, {
  selectedAnswers: { decisionTargetA: 'optionA' },
  executedCommands: ['inspect-host-a'],
});
assert.deepEqual(validates(withCanonicalCommand), withCanonicalCommand);
assert.throws(
  () => serializeProtectedResponse(question, { executedCommands: ['display text is not a command ID'] }),
  /invalid_multi_host_command_state/,
);

// F. Resume restores scorer state while terminal display/history remains ephemeral.
const resumed = deserializeProtectedResponse(question, evidenceAndDecision);
assert.deepEqual(resumed, { evidenceTargetA: 'inspected', decisionTargetA: 'optionB' });
assert.deepEqual(serializeProtectedResponse(question, resumed), evidenceAndDecision);
assert.equal(Object.hasOwn(resumed, 'perHostCommandHistory'), false);
assert.equal(Object.hasOwn(resumed, 'perHostTerminalTranscript'), false);
assert.deepEqual(
  deserializeProtectedResponse(question, withCanonicalCommand),
  { decisionTargetA: 'optionA', executedCommands: ['inspect-host-a'] },
);

// Existing PBQ families retain their canonical envelopes and validator acceptance.
const mapDefinition = {
  responseAllowlist: {
    targetIds: ['targetA'],
    answerIdsByTarget: { targetA: ['optionA'] },
  },
};
for (const type of [
  'pbq-network-diagram',
  'pbq-config-panel',
  'pbq-hotspot',
  'pbq-drag-drop-match',
  'pbq-workspace',
]) {
  const serialized = serializeProtectedResponse(
    { type, responseAllowlist: mapDefinition.responseAllowlist },
    { targetA: 'optionA' },
  );
  assert.deepEqual(serialized, { selectedAnswers: { targetA: 'optionA' } }, `${type} envelope drifted`);
  assert.deepEqual(validateAndCanonicalizePBQResponse(mapDefinition, serialized).value, serialized);
  assert.deepEqual(
    deserializeProtectedResponse({ type, responseAllowlist: mapDefinition.responseAllowlist }, serialized),
    { targetA: 'optionA' },
  );
}
const terminal = serializeProtectedResponse(
  {
    type: 'pbq-terminal',
    responseAllowlist: { answerIds: ['optionA'], commandIds: ['inspect-host-a'] },
  },
  { selectedAnswer: 'optionA', executedCommands: ['inspect-host-a'], commandHistory: ['browser only'] },
);
assert.deepEqual(terminal, { selectedAnswer: 'optionA', executedCommands: ['inspect-host-a'] });
assert.deepEqual(validateAndCanonicalizePBQResponse({ responseAllowlist: { answerIds: ['optionA'], commandIds: ['inspect-host-a'] } }, terminal).value, terminal);
const ordering = serializeProtectedResponse(
  { type: 'pbq-ordering', responseAllowlist: { orderIds: ['first', 'second'] } },
  ['second', 'first'],
);
assert.deepEqual(ordering, { selectedOrder: ['second', 'first'] });
assert.deepEqual(validateAndCanonicalizePBQResponse({ responseAllowlist: { orderIds: ['first', 'second'] } }, ordering).value, ordering);

// Ordinary and INF-303 structured response contracts remain unchanged.
const ordinary = [
  [{ type: 'single-choice' }, 'a', { answer: 'a' }],
  [{ type: 'multi-select' }, ['a', 'b'], { answer: ['a', 'b'] }],
  [{ type: 'reorder' }, ['b', 'a'], { answer: ['b', 'a'] }],
  [{ type: 'drag-drop-match' }, { sourceA: 'targetA' }, { answer: { sourceA: 'targetA' } }],
  [{ type: 'dropdown-code' }, { blankA: 'optionA' }, { answer: { blankA: 'optionA' } }],
  [{ type: 'dropdown-command' }, { blankA: 'optionA' }, { answer: { blankA: 'optionA' } }],
  [{ type: 'true-false-single-v1' }, false, { answer: false }],
  [{ type: 'true-false-composite-v1' }, { statementA: true }, { answer: { statementA: true } }],
  [{ type: 'matching-v1' }, { sourceA: 'targetA' }, { answer: { sourceA: 'targetA' } }],
  [{ type: 'code-dropdown-completion-v1' }, { blankA: 'optionA' }, { answer: { blankA: 'optionA' } }],
];
for (const [ordinaryQuestion, answer, expected] of ordinary) {
  assert.deepEqual(serializeProtectedResponse(ordinaryQuestion, answer), expected, `${ordinaryQuestion.type} serialization drifted`);
  assert.deepEqual(deserializeProtectedResponse(ordinaryQuestion, expected), answer, `${ordinaryQuestion.type} resume drifted`);
}

const [contractSource, multiHostSource, runnerSource, validatorSql, integrationSource, playwrightSource, packageSource] = await Promise.all([
  readFile(new URL('../src/lib/protectedExamContract.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pbq/MultiHostTerminalLab.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260909072811_issue124_protected_array_response_validator_fix.sql', import.meta.url), 'utf8'),
  readFile(new URL('./test-generic-protected-lifecycle-integration.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../tests/r3g/protected-lifecycle.spec.js', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);
assert.match(contractSource, /type === 'pbq-multi-host-terminal'[\s\S]+serializeMultiHostTerminalResponse/);
assert.match(contractSource, /question\?\.responseAllowlist \?\? question\?\.presentation\?\.responseAllowlist/);
assert.match(contractSource, /MULTI_HOST_BROWSER_ONLY_KEYS/);
assert.match(multiHostSource, /perHostCommandHistory/);
assert.match(multiHostSource, /perHostTerminalTranscript/);
assert.match(runnerSource, /serializeProtectedResponse\(question, answers\[itemId\]\)/);
assert.match(validatorSql, /p_question_type like 'pbq-%'/);
assert.match(validatorSql, /responseAllowlist/);
assert.match(validatorSql, /jsonb_each_text\(p_response->'selectedAnswers'\)/);
assert.match(integrationSource, /ISSUE166_HARMLESS_DUPLICATE_REPLACED_SAVED_SANDBOX/);
assert.match(integrationSource, /ISSUE166_HARMLESS_DUPLICATE_LOST_SAVED_SANDBOX_RESPONSES/);
assert.match(playwrightSource, /multi-host PBQ saves only allowlisted scorer state/);
assert.match(playwrightSource, /perHostCommandHistory\|perHostTerminalTranscript/);
assert.match(packageSource, /"validate:issue166"/);

console.log('Issue #166 multi-host PBQ serialization, resume, regressions, and duplicate-start safety contracts validated.');
