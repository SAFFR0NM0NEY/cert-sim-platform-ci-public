import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  deserializeProtectedResponse,
  serializeProtectedResponse,
} from '../src/lib/protectedExamContract.js';
import { validateAndCanonicalizePBQResponse } from './backend-exam-publication/pbq-runtime.mjs';

const mapAllowlist = (entries, commandIds = []) => ({
  targetIds: entries.map(([targetId]) => targetId),
  answerIdsByTarget: entries.map(([targetId, answerIds]) => ({ targetId, answerIds })),
  commandIds,
});

const fixtures = [
  {
    label: 'config-panel interactive-topology',
    question: {
      type: 'pbq-config-panel',
      tasks: { interactionStyle: 'interactive-topology' },
      responseAllowlist: mapAllowlist([
        ['config-evidence', ['selected']],
        ['config-decision', ['allow', 'deny']],
      ]),
    },
    browserAnswer: {
      'config-evidence': 'selected',
      'config-decision': 'allow',
      perHostCommandHistory: { host: ['inspect synthetic state'] },
      perHostTerminalTranscript: {
        host: [{ id: 'browser-timestamp', output: 'browser-only terminal output' }],
      },
    },
    expected: {
      selectedAnswers: {
        'config-evidence': 'selected',
        'config-decision': 'allow',
      },
    },
  },
  {
    label: 'firewall interactive-topology',
    question: {
      type: 'pbq-firewall',
      interactionStyle: 'interactive-topology',
      responseAllowlist: mapAllowlist([
        ['firewall-evidence', ['selected']],
        ['firewall-action', ['permit', 'block']],
      ]),
    },
    browserAnswer: {
      'firewall-evidence': 'selected',
      'firewall-action': 'block',
      perHostCommandHistory: {},
      perHostTerminalTranscript: {},
    },
    expected: {
      selectedAnswers: {
        'firewall-evidence': 'selected',
        'firewall-action': 'block',
      },
    },
  },
  {
    label: 'hotspot interactive-topology',
    question: {
      type: 'pbq-hotspot',
      tasks: { interactionStyle: 'interactive-topology' },
      presentation: {
        responseAllowlist: mapAllowlist([
          ['hotspot-evidence', ['selected']],
          ['hotspot-decision', ['zone-a', 'zone-b']],
        ]),
      },
    },
    browserAnswer: {
      'hotspot-evidence': 'selected',
      'hotspot-decision': 'zone-b',
      perHostCommandHistory: { sensor: [] },
      perHostTerminalTranscript: { sensor: [] },
    },
    expected: {
      selectedAnswers: {
        'hotspot-evidence': 'selected',
        'hotspot-decision': 'zone-b',
      },
    },
  },
  {
    label: 'multi-host interactive-topology',
    question: {
      type: 'pbq-multi-host-terminal',
      tasks: { interactionStyle: 'interactive-topology' },
      responseAllowlist: mapAllowlist([
        ['host-evidence', ['inspected']],
        ['host-decision', ['isolate', 'retain']],
      ], ['inspect-host']),
    },
    browserAnswer: {
      'host-evidence': 'inspected',
      'host-decision': 'isolate',
      executedCommands: ['inspect-host'],
      perHostCommandHistory: { host: ['inspect host'] },
      perHostTerminalTranscript: { host: [{ output: 'browser-only output' }] },
    },
    expected: {
      selectedAnswers: {
        'host-evidence': 'inspected',
        'host-decision': 'isolate',
      },
      executedCommands: ['inspect-host'],
    },
  },
  {
    label: 'AZ-400 workspace',
    question: {
      type: 'pbq-config-panel',
      tasks: { interactionStyle: 'workspace' },
      responseAllowlist: mapAllowlist([
        ['workspace-setting', ['enabled', 'disabled']],
      ]),
    },
    browserAnswer: { 'workspace-setting': 'enabled' },
    expected: { selectedAnswers: { 'workspace-setting': 'enabled' } },
  },
  {
    label: 'investigation-review',
    question: {
      type: 'pbq-config-panel',
      tasks: { interactionStyle: 'investigation-review' },
      responseAllowlist: mapAllowlist([
        ['investigation-evidence', ['selected']],
        ['investigation-decision', ['escalate', 'close']],
      ]),
    },
    browserAnswer: {
      'investigation-evidence': 'selected',
      'investigation-decision': 'escalate',
    },
    expected: {
      selectedAnswers: {
        'investigation-evidence': 'selected',
        'investigation-decision': 'escalate',
      },
    },
  },
  {
    label: 'practical-sections',
    question: {
      type: 'pbq-config-panel',
      tasks: { interactionStyle: 'practical-sections' },
      responseAllowlist: mapAllowlist([
        ['practical-setting', ['one', 'two']],
      ]),
    },
    browserAnswer: { 'practical-setting': 'two' },
    expected: { selectedAnswers: { 'practical-setting': 'two' } },
  },
];

for (const fixture of fixtures) {
  const serialized = serializeProtectedResponse(fixture.question, fixture.browserAnswer);
  assert.deepEqual(serialized, fixture.expected, `${fixture.label} serialization drifted`);
  const allowlist = fixture.question.responseAllowlist ?? fixture.question.presentation.responseAllowlist;
  assert.deepEqual(
    validateAndCanonicalizePBQResponse({ responseAllowlist: allowlist }, serialized).value,
    fixture.expected,
    `${fixture.label} JS validator parity failed`,
  );
  const resumed = deserializeProtectedResponse(fixture.question, serialized);
  assert.deepEqual(
    serializeProtectedResponse(fixture.question, resumed),
    fixture.expected,
    `${fixture.label} resume round-trip drifted`,
  );
  assert.doesNotMatch(
    JSON.stringify(serialized),
    /perHostCommandHistory|perHostTerminalTranscript|browser-only|timestamp/i,
    `${fixture.label} persisted browser state`,
  );
}

const productionFailureShape = { selectedAnswers: fixtures[0].browserAnswer };
assert.throws(
  () => validateAndCanonicalizePBQResponse(
    { responseAllowlist: fixtures[0].question.responseAllowlist },
    productionFailureShape,
  ),
  /PBQ_RESPONSE_FOREIGN_TARGET|PBQ_RESPONSE_FOREIGN_ANSWER/,
);

// Existing ordinary flat-map PBQ renderers use the same projection boundary.
for (const type of [
  'pbq-config-panel',
  'pbq-firewall',
  'pbq-hotspot',
  'pbq-network-diagram',
  'pbq-drag-drop-match',
  'pbq-workspace',
]) {
  const responseAllowlist = mapAllowlist([['target', ['value']]]);
  assert.deepEqual(
    serializeProtectedResponse({ type, responseAllowlist }, { target: 'value' }),
    { selectedAnswers: { target: 'value' } },
    `${type} flat-map projection drifted`,
  );
}

// Canonical envelope families remain allowlist-validated and omit UI-only state.
const terminalQuestion = {
  type: 'pbq-terminal',
  responseAllowlist: { answerIds: ['answer-a'], commandIds: ['inspect'] },
};
const terminal = serializeProtectedResponse(terminalQuestion, {
  selectedAnswer: 'answer-a',
  executedCommands: ['inspect'],
  commandHistory: ['browser-only command display'],
  terminalTranscript: [{ output: 'browser-only terminal output' }],
});
assert.deepEqual(terminal, { selectedAnswer: 'answer-a', executedCommands: ['inspect'] });
assert.deepEqual(
  validateAndCanonicalizePBQResponse({ responseAllowlist: terminalQuestion.responseAllowlist }, terminal).value,
  terminal,
);
const orderingQuestion = {
  type: 'pbq-ordering',
  responseAllowlist: { orderIds: ['first', 'second'] },
};
assert.deepEqual(
  serializeProtectedResponse(orderingQuestion, ['second', 'first']),
  { selectedOrder: ['second', 'first'] },
);

// Empty flat-map UI values clear a selection instead of entering the scorer payload.
const failClosedQuestion = fixtures[0].question;
assert.deepEqual(
  serializeProtectedResponse(failClosedQuestion, {
    'config-evidence': '',
    'config-decision': '',
    perHostCommandHistory: {},
    perHostTerminalTranscript: {},
  }),
  { selectedAnswers: {} },
);

const expectFailure = (operation, code) => {
  assert.throws(operation, (error) => error instanceof Error && error.message === code);
};
expectFailure(
  () => serializeProtectedResponse(failClosedQuestion, { 'unknown-target': 'allow' }),
  'invalid_pbq_response_target',
);
expectFailure(
  () => serializeProtectedResponse(failClosedQuestion, { 'config-decision': 'unknown-answer' }),
  'invalid_pbq_response_value',
);
expectFailure(
  () => serializeProtectedResponse(failClosedQuestion, { 'config-decision': { nested: true } }),
  'invalid_pbq_response_value',
);
expectFailure(
  () => serializeProtectedResponse(failClosedQuestion, { arbitraryBrowserPanel: { open: true } }),
  'invalid_pbq_response_target',
);
expectFailure(
  () => serializeProtectedResponse({ type: 'pbq-config-panel' }, { 'config-decision': 'allow' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...failClosedQuestion,
    responseAllowlist: {
      ...failClosedQuestion.responseAllowlist,
      targetIds: ['config-evidence', 'config-evidence'],
    },
  }, { 'config-evidence': 'selected' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...failClosedQuestion,
    responseAllowlist: {
      ...failClosedQuestion.responseAllowlist,
      targetIds: null,
    },
  }, { 'config-evidence': 'selected' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...failClosedQuestion,
    responseAllowlist: {
      targetIds: ['config-evidence'],
      answerIdsByTarget: [
        { targetId: 'config-evidence', answerIds: ['selected'] },
        { targetId: 'config-evidence', answerIds: ['selected'] },
      ],
    },
  }, { 'config-evidence': 'selected' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...failClosedQuestion,
    responseAllowlist: {
      targetIds: ['config-evidence'],
      answerIdsByTarget: { 'config-evidence': ['selected', 'selected'] },
    },
  }, { 'config-evidence': 'selected' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...failClosedQuestion,
    responseAllowlist: {
      targetIds: ['config-evidence'],
      answerIdsByTarget: { other: ['selected'] },
    },
  }, { 'config-evidence': 'selected' }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse({
    ...terminalQuestion,
    responseAllowlist: { ...terminalQuestion.responseAllowlist, commandIds: ['inspect', 'inspect'] },
  }, { executedCommands: ['inspect'] }),
  'invalid_pbq_response_allowlist',
);
expectFailure(
  () => serializeProtectedResponse(terminalQuestion, { executedCommands: ['unknown-command'] }),
  'invalid_pbq_command_state',
);

// Issue #166 keeps its canonical output and legacy fail-closed error contract.
const issue166Question = fixtures[3].question;
expectFailure(
  () => serializeProtectedResponse(issue166Question, { foreign: 'isolate' }),
  'invalid_multi_host_response_target',
);
expectFailure(
  () => serializeProtectedResponse(issue166Question, { 'host-decision': 'foreign' }),
  'invalid_multi_host_response_value',
);
expectFailure(
  () => serializeProtectedResponse(issue166Question, { executedCommands: ['foreign'] }),
  'invalid_multi_host_command_state',
);

// Ordinary and INF-303 response contracts remain unchanged.
for (const [question, answer, expected] of [
  [{ type: 'single-choice' }, 'a', { answer: 'a' }],
  [{ type: 'multi-select' }, ['a', 'b'], { answer: ['a', 'b'] }],
  [{ type: 'reorder' }, ['b', 'a'], { answer: ['b', 'a'] }],
  [{ type: 'drag-drop-match' }, { source: 'target' }, { answer: { source: 'target' } }],
  [{ type: 'dropdown-code' }, { blank: 'option' }, { answer: { blank: 'option' } }],
  [{ type: 'dropdown-command' }, { blank: 'option' }, { answer: { blank: 'option' } }],
  [{ type: 'true-false-single-v1' }, false, { answer: false }],
  [{ type: 'true-false-composite-v1' }, { statement: true }, { answer: { statement: true } }],
  [{ type: 'matching-v1' }, { source: 'target' }, { answer: { source: 'target' } }],
  [{ type: 'code-dropdown-completion-v1' }, { blank: 'option' }, { answer: { blank: 'option' } }],
]) {
  assert.deepEqual(serializeProtectedResponse(question, answer), expected);
  assert.deepEqual(deserializeProtectedResponse(question, expected), answer);
}

const componentNames = [
  'WorkspacePBQLab',
  'InteractiveInvestigationLab',
  'PracticalPBQLab',
  'ConfigPanelLab',
  'FirewallRuleSimulator',
  'EvidenceSelectionLab',
  'NetworkDiagramLab',
  'PBQMatchingLab',
  'PBQOrderingLab',
  'SimulatedTerminal',
  'MultiHostTerminalLab',
  'InteractiveTopologyLab',
];
const [contractSource, routerSource, packageSource, integrationSource, ...componentSources] = await Promise.all([
  readFile(new URL('../src/lib/protectedExamContract.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pbq/PBQExamQuestion.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./test-issue169-protected-save-integration.mjs', import.meta.url), 'utf8'),
  ...componentNames.map((name) => readFile(
    new URL(`../src/components/pbq/${name}.jsx`, import.meta.url),
    'utf8',
  )),
]);
assert.doesNotMatch(contractSource, /selectedAnswers:\s*response/);
assert.match(contractSource, /serializeAllowlistedPBQResponse/);
assert.match(contractSource, /question\?\.responseAllowlist \?\? question\?\.presentation\?\.responseAllowlist/);
assert.match(contractSource, /PBQ_BROWSER_ONLY_KEYS/);
assert.ok(
  routerSource.indexOf("=== 'interactive-topology'") < routerSource.indexOf("lab.type === 'pbq-firewall'"),
  'interaction-style routing must remain authoritative before type-specific PBQ routing',
);
assert.match(routerSource, /<WorkspacePBQLab/);
assert.match(routerSource, /<InteractiveInvestigationLab/);
assert.match(routerSource, /<PracticalPBQLab/);
for (const [index, source] of componentSources.entries()) {
  assert.match(source, /export default function/, `${componentNames[index]} audit source missing`);
}
assert.match(componentSources.at(-1), /perHostCommandHistory/);
assert.match(componentSources.at(-1), /perHostTerminalTranscript/);
assert.match(componentSources.at(-2), /perHostCommandHistory/);
assert.match(componentSources.at(-2), /perHostTerminalTranscript/);
assert.match(componentSources.at(-3), /commandHistory/);
assert.match(componentSources.at(-3), /terminalTranscript/);
assert.match(packageSource, /"validate:issue169"/);
assert.match(packageSource, /"test:issue169-db"/);
assert.match(integrationSource, /certsim_protected_save_response/);
assert.match(integrationSource, /certsim_protected_resume_attempt/);
assert.match(integrationSource, /ISSUE169_DISPOSABLE_LOCAL_DATABASE_REQUIRED/);

console.log('Issue #169 interactive-topology PBQ allowlist projection, fail-closed, renderer audit, and validator-parity contracts validated.');
