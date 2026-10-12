import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveReleasedPbqAnswer } from '../src/lib/releasedAnswerDisplay.js';

const option = (id, label) => ({ id, label });
const fixtures = [
  {
    type: 'pbq-terminal',
    presentation: {
      allowedCommands: ['inspect service', 'verify policy'],
      tasks: { answerOptions: [option('terminal-allow', 'Allow HTTPS'), option('terminal-deny', 'Deny traffic')] },
    },
    response: { selectedAnswer: 'terminal-allow', executedCommands: ['inspect service'] },
    correct: { expectedAnswer: 'terminal-allow', requiredCommandIds: ['verify policy'] },
    expected: ['Allow HTTPS', 'inspect service', 'verify policy'],
    privateIds: ['terminal-allow'],
    malformed: { selectedAnswer: 'terminal-private' },
  },
  {
    type: 'pbq-multi-host-terminal',
    presentation: {
      assets: { hosts: [{ id: 'host-a', label: 'Server A', allowedCommands: ['inspect host'] }] },
      tasks: {
        commandEvidenceTargets: [{ id: 'evidence-a', label: 'Server A evidence', hostId: 'host-a', commands: ['inspect host'] }],
        decisionTargets: [{ id: 'decision-a', label: 'Deployment environment', options: [option('environment-production', 'Production')] }],
      },
    },
    response: { selectedAnswers: { 'evidence-a': 'inspected', 'decision-a': 'environment-production' }, executedCommands: ['inspect host'] },
    correct: { expectedMap: { 'evidence-a': 'inspected', 'decision-a': 'environment-production' }, requiredCommandIds: ['inspect host'] },
    expected: ['Server A evidence', 'Deployment environment', 'Production', 'inspect host'],
    privateIds: ['evidence-a', 'decision-a', 'environment-production'],
    malformed: { selectedAnswers: { 'decision-a': 'private-option' } },
  },
  {
    type: 'pbq-firewall',
    presentation: { tasks: { ruleFields: [{ id: 'firewall-action', label: 'Rule action', options: [option('firewall-allow', 'Allow HTTPS')] }] } },
    response: { selectedAnswers: { 'firewall-action': 'firewall-allow' } },
    correct: { expectedMap: { 'firewall-action': 'firewall-allow' }, requiredCommandIds: [] },
    expected: ['Rule action', 'Allow HTTPS'],
    privateIds: ['firewall-action', 'firewall-allow'],
    malformed: { selectedAnswers: { 'firewall-private': 'firewall-allow' } },
  },
  {
    type: 'pbq-siem',
    presentation: {
      tasks: {
        interactionStyle: 'investigation-review',
        evidenceItems: [{ id: 'siem-evidence', label: 'Server A alert' }],
        selectionOptions: [option('siem-escalate', 'Escalate')],
        decisionTargets: [{ id: 'siem-decision', label: 'Incident action', options: [option('siem-contain', 'Contain host')] }],
      },
    },
    response: { selectedAnswers: { 'siem-evidence': 'siem-escalate', 'siem-decision': 'siem-contain' } },
    correct: { expectedMap: { 'siem-evidence': 'siem-escalate', 'siem-decision': 'siem-contain' }, requiredCommandIds: [] },
    expected: ['Server A alert', 'Escalate', 'Incident action', 'Contain host'],
    privateIds: ['siem-evidence', 'siem-escalate', 'siem-decision', 'siem-contain'],
    malformed: { selectedAnswers: [] },
  },
  {
    type: 'pbq-network-diagram',
    presentation: {
      tasks: {
        controlPlacementTargets: [{ id: 'diagram-edge', label: 'Internet edge' }],
        controlOptions: [option('diagram-waf', 'Web application firewall')],
      },
    },
    response: { selectedAnswers: { 'diagram-edge': 'diagram-waf' } },
    correct: { expectedMap: { 'diagram-edge': 'diagram-waf' }, requiredCommandIds: [] },
    expected: ['Internet edge', 'Web application firewall'],
    privateIds: ['diagram-edge', 'diagram-waf'],
    malformed: { selectedAnswers: { 'diagram-edge': 'diagram-private' } },
  },
  {
    type: 'pbq-config-panel',
    presentation: {
      tasks: {
        configurationTargets: [{ id: 'config-server', label: 'Server A', options: [option('config-production', 'Production')] }],
      },
    },
    response: { selectedAnswers: { 'config-server': 'config-production' } },
    correct: { expectedMap: { 'config-server': 'config-production' }, requiredCommandIds: [] },
    expected: ['Server A', 'Production'],
    privateIds: ['config-server', 'config-production'],
    malformed: { selectedAnswers: 'config-private' },
  },
  {
    type: 'pbq-hotspot',
    presentation: {
      tasks: {
        evidenceItems: [{ id: 'hotspot-server', label: 'Server A' }],
        selectionOptions: [option('hotspot-isolate', 'Isolate host')],
      },
    },
    response: { selectedAnswers: { 'hotspot-server': 'hotspot-isolate' } },
    correct: { expectedMap: { 'hotspot-server': 'hotspot-isolate' }, requiredCommandIds: [] },
    expected: ['Server A', 'Isolate host'],
    privateIds: ['hotspot-server', 'hotspot-isolate'],
    malformed: { selectedAnswers: { 'hotspot-private': 'hotspot-isolate' } },
  },
  {
    type: 'pbq-drag-drop-match',
    presentation: {
      tasks: {
        matchTargets: [{ id: 'match-server', label: 'Server A' }],
        mitigationOptions: [option('match-patch', 'Apply security update')],
      },
    },
    response: { selectedAnswers: { 'match-server': 'match-patch' } },
    correct: { expectedMap: { 'match-server': 'match-patch' }, requiredCommandIds: [] },
    expected: ['Server A', 'Apply security update'],
    privateIds: ['match-server', 'match-patch'],
    malformed: { selectedAnswers: { 'match-server': 'match-private' } },
  },
  {
    type: 'pbq-ordering',
    presentation: { tasks: { items: [{ id: 'order-one', text: 'Step One' }, { id: 'order-two', text: 'Step Two' }] } },
    response: { selectedOrder: ['order-two', 'order-one'] },
    correct: { expectedOrder: ['order-one', 'order-two'], requiredCommandIds: [] },
    expected: ['Step One', 'Step Two'],
    privateIds: ['order-one', 'order-two'],
    malformed: { selectedOrder: ['order-one', 'order-one'] },
  },
  {
    type: 'pbq-workspace',
    presentation: {
      tasks: {
        interactionStyle: 'workspace',
        workspace: {
          tabs: [{ id: 'workspace-tab', title: 'Deployment', decisions: [{ id: 'workspace-target', prompt: 'Deployment environment', options: [option('workspace-production', 'Production')] }] }],
        },
      },
    },
    response: { selectedAnswers: { 'workspace-target': 'workspace-production' } },
    correct: { expectedMap: { 'workspace-target': 'workspace-production' }, requiredCommandIds: [] },
    expected: ['Deployment environment', 'Production'],
    privateIds: ['workspace-target', 'workspace-production'],
    malformed: { selectedAnswers: { 'workspace-private': 'workspace-production' } },
  },
];

for (const fixture of fixtures) {
  const response = resolveReleasedPbqAnswer(fixture.presentation, fixture.response, { questionType: fixture.type });
  const correct = resolveReleasedPbqAnswer(fixture.presentation, fixture.correct, { correct: true, questionType: fixture.type });
  assert.equal(response.status, 'resolved', `${fixture.type} learner response`);
  assert.equal(correct.status, 'resolved', `${fixture.type} correct response`);
  const display = `${JSON.stringify(response)} ${JSON.stringify(correct)}`;
  for (const text of fixture.expected) assert.match(display, new RegExp(escapeRegExp(text)), `${fixture.type}: ${text}`);
  for (const id of fixture.privateIds) assert.doesNotMatch(display, new RegExp(escapeRegExp(id)), `${fixture.type} leaked ${id}`);
  assert.equal(resolveReleasedPbqAnswer(fixture.presentation, fixture.malformed, { questionType: fixture.type }).status, 'invalid', `${fixture.type} malformed response`);
  assert.equal(resolveReleasedPbqAnswer(fixture.presentation, {}, { questionType: fixture.type }).status, 'empty', `${fixture.type} empty response`);
}

const interactionVariants = [
  {
    name: 'global config options',
    type: 'pbq-config-panel',
    presentation: { tasks: { configurationTargets: [{ id: 'global-target', label: 'Server A' }], permissionOptions: [option('global-value', 'Production')] } },
    value: { selectedAnswers: { 'global-target': 'global-value' } },
    expected: ['Server A', 'Production'],
    privateIds: ['global-target', 'global-value'],
  },
  {
    name: 'interactive topology',
    type: 'pbq-network-diagram',
    presentation: {
      assets: { deviceTools: { server: [{ id: 'inspect-server', label: 'Inspect server' }] } },
      tasks: {
        interactionStyle: 'interactive-topology',
        commandEvidenceTargets: [{ id: 'topology-evidence', label: 'Server A evidence' }],
        evidenceItems: [{ id: 'topology-alert', label: 'Server A alert' }],
        selectionOptions: [option('topology-select', 'Escalate')],
        decisionTargets: [{ id: 'topology-decision', label: 'Network action', options: [option('topology-isolate', 'Isolate host')] }],
      },
    },
    value: { selectedAnswers: { 'topology-evidence': 'inspected', 'topology-alert': 'topology-select', 'topology-decision': 'topology-isolate' }, executedCommands: ['inspect server'] },
    expected: ['Server A evidence', 'Server A alert', 'Escalate', 'Network action', 'Isolate host', 'Inspect server'],
    privateIds: ['topology-evidence', 'topology-alert', 'topology-select', 'topology-decision', 'topology-isolate'],
  },
  {
    name: 'practical sections',
    type: 'pbq-config-panel',
    presentation: { tasks: { interactionStyle: 'practical-sections', sections: [{ id: 'section-a', targets: [{ id: 'practical-target', label: 'Deployment slot', options: [option('practical-production', 'Production')] }] }] } },
    value: { selectedAnswers: { 'practical-target': 'practical-production' } },
    expected: ['Deployment slot', 'Production'],
    privateIds: ['practical-target', 'practical-production'],
  },
  {
    name: 'network node fallback',
    type: 'pbq-network-diagram',
    presentation: { assets: { networkNodes: [{ id: 'node-a', label: 'Internet edge' }] }, tasks: { classificationOptions: [option('node-control', 'Web application firewall')] } },
    value: { selectedAnswers: { 'node-a': 'node-control' } },
    expected: ['Internet edge', 'Web application firewall'],
    privateIds: ['node-a', 'node-control'],
  },
];
for (const variant of interactionVariants) {
  const result = resolveReleasedPbqAnswer(variant.presentation, variant.value, { questionType: variant.type });
  assert.equal(result.status, 'resolved', variant.name);
  const display = JSON.stringify(result);
  for (const text of variant.expected) assert.match(display, new RegExp(escapeRegExp(text)), `${variant.name}: ${text}`);
  for (const id of variant.privateIds) assert.doesNotMatch(display, new RegExp(escapeRegExp(id)), `${variant.name} leaked ${id}`);
}

const collisionTarget = {
  id: 'collision-action',
  label: 'Containment action',
  options: [option('collision-isolate', 'Isolate host')],
};
const collisionTool = {
  id: 'inspect-tool',
  command: 'inspect server',
  label: 'Inspect server configuration',
};
const collisionTasks = {
  interactionStyle: 'interactive-topology',
  decisionTargets: [collisionTarget],
};
const collisionCorrect = {
  expectedMap: { 'collision-action': 'collision-isolate' },
  requiredCommandIds: ['inspect server'],
};
const collisionPresentation = (devices) => ({ assets: { devices }, tasks: collisionTasks });
const fallbackFirstCollision = collisionPresentation([{
  id: 'fallback-first-host',
  allowedCommands: ['inspect server'],
  tools: [collisionTool],
}]);
const explicitFirstCollision = collisionPresentation([
  { id: 'explicit-first-host', tools: [collisionTool] },
  { id: 'fallback-second-host', allowedCommands: [' INSPECT   SERVER '] },
]);

for (const [name, presentation] of [
  ['fallback then explicit', fallbackFirstCollision],
  ['explicit then fallback', explicitFirstCollision],
]) {
  assert.equal(resolveReleasedPbqAnswer(presentation, {}, { questionType: 'pbq-config-panel' }).status, 'empty', `${name}: empty learner response`);
  const correct = resolveReleasedPbqAnswer(presentation, collisionCorrect, { correct: true, questionType: 'pbq-config-panel' });
  assert.equal(correct.status, 'resolved', `${name}: expected answer`);
  assert.match(JSON.stringify(correct), /Inspect server configuration/, `${name}: explicit command label`);
  assert.doesNotMatch(JSON.stringify(correct), /"inspect server"/, `${name}: raw fallback command label`);
}
assert.deepEqual(
  resolveReleasedPbqAnswer(fallbackFirstCollision, collisionCorrect, { correct: true, questionType: 'pbq-config-panel' }),
  resolveReleasedPbqAnswer(explicitFirstCollision, collisionCorrect, { correct: true, questionType: 'pbq-config-panel' }),
  'command label priority must be traversal-order independent',
);

const aliasResult = resolveReleasedPbqAnswer(
  fallbackFirstCollision,
  { executedCommands: ['inspect server', 'inspect-tool'] },
  { questionType: 'pbq-config-panel' },
);
assert.equal(aliasResult.status, 'resolved');
assert.deepEqual(aliasResult.groups[0].texts, ['Inspect server configuration', 'Inspect server configuration']);

const ambiguousCommandLabels = collisionPresentation([
  { id: 'ambiguous-host-a', tools: [{ id: 'inspect-a', command: 'inspect server', label: 'Inspect server' }] },
  { id: 'ambiguous-host-b', tools: [{ id: 'inspect-b', command: 'inspect server', label: 'Review server policy' }] },
]);
assert.equal(
  resolveReleasedPbqAnswer(ambiguousCommandLabels, {}, { questionType: 'pbq-config-panel' }).status,
  'invalid',
  'different explicit labels for one command identity must fail closed',
);

const sameLabelDifferentCommands = collisionPresentation([{
  id: 'separate-command-host',
  tools: [
    { id: 'inspect-alias', command: 'inspect server', label: 'Review server' },
    { id: 'review-alias', command: 'review server', label: 'Review server' },
  ],
}]);
assert.equal(
  resolveReleasedPbqAnswer(sameLabelDifferentCommands, { executedCommands: ['inspect server', 'review server'] }, { questionType: 'pbq-config-panel' }).status,
  'resolved',
  'different command identities may share one explicit display label',
);

const punctuationDistinct = collisionPresentation([{
  id: 'punctuation-host',
  allowedCommands: ['inspect-server', 'inspect server'],
}]);
assert.equal(
  resolveReleasedPbqAnswer(punctuationDistinct, { executedCommands: ['inspect-server', 'inspect server'] }, { questionType: 'pbq-config-panel' }).status,
  'resolved',
  'punctuation-distinct command identities must remain separate',
);

const config = fixtures.find(({ type }) => type === 'pbq-config-panel');
assert.equal(resolveReleasedPbqAnswer(config.presentation, { unknownResponseKey: 'private-value' }, { questionType: config.type }).status, 'invalid');
assert.equal(resolveReleasedPbqAnswer(config.presentation, { strategy: 'future-strategy', expectedMap: {} }, { correct: true, questionType: config.type }).status, 'invalid');
assert.equal(resolveReleasedPbqAnswer(config.presentation, { expectedMap: { 'config-server': 'private-option' } }, { correct: true, questionType: config.type }).status, 'invalid');
assert.equal(resolveReleasedPbqAnswer(config.presentation, { expectedMap: [], requiredCommandIds: [] }, { correct: true, questionType: config.type }).status, 'invalid');
assert.equal(resolveReleasedPbqAnswer(config.presentation, null, { questionType: config.type }).status, 'empty');
assert.equal(resolveReleasedPbqAnswer({}, { displayUnavailable: true }, { questionType: config.type }).status, 'unavailable');
assert.equal(resolveReleasedPbqAnswer({}, { displayUnavailable: true }, { correct: true, questionType: config.type }).status, 'unavailable');
assert.equal(resolveReleasedPbqAnswer(config.presentation, { displayUnavailable: true, ready: true }, { questionType: config.type }).status, 'invalid');

const idOnlyEvidence = {
  tasks: {
    evidenceItems: [{ id: 'evidence-only', label: 'Server A alert' }],
    selectionOptions: [{ id: 'selected-only' }],
  },
};
const idOnlyResult = resolveReleasedPbqAnswer(idOnlyEvidence, { selectedAnswers: { 'evidence-only': 'selected-only' } }, { questionType: 'pbq-hotspot' });
assert.equal(idOnlyResult.status, 'resolved');
assert.deepEqual(idOnlyResult.groups, [{ kind: 'lines', label: 'Selected items', texts: ['Server A alert'] }]);
assert.doesNotMatch(JSON.stringify(idOnlyResult), /evidence-only|selected-only/);
const defaultEvidenceResult = resolveReleasedPbqAnswer(
  { tasks: { evidenceItems: [{ id: 'default-evidence', label: 'Server A alert' }] } },
  { selectedAnswers: { 'default-evidence': 'selected' } },
  { questionType: 'pbq-hotspot' },
);
assert.deepEqual(defaultEvidenceResult.groups, [{ kind: 'lines', label: 'Selected items', texts: ['Server A alert'] }]);

const duplicateTargetPresentation = structuredClone(config.presentation);
duplicateTargetPresentation.tasks.configurationTargets.push(structuredClone(duplicateTargetPresentation.tasks.configurationTargets[0]));
assert.equal(resolveReleasedPbqAnswer(duplicateTargetPresentation, config.response, { questionType: config.type }).status, 'invalid');
const duplicateOptionPresentation = structuredClone(config.presentation);
duplicateOptionPresentation.tasks.configurationTargets[0].options.push(structuredClone(duplicateOptionPresentation.tasks.configurationTargets[0].options[0]));
assert.equal(resolveReleasedPbqAnswer(duplicateOptionPresentation, config.response, { questionType: config.type }).status, 'invalid');
const missingLabelPresentation = structuredClone(config.presentation);
delete missingLabelPresentation.tasks.configurationTargets[0].label;
assert.equal(resolveReleasedPbqAnswer(missingLabelPresentation, config.response, { questionType: config.type }).status, 'invalid');

const terminal = fixtures.find(({ type }) => type === 'pbq-terminal');
assert.equal(resolveReleasedPbqAnswer(terminal.presentation, { executedCommands: 'inspect service' }, { questionType: terminal.type }).status, 'invalid');
assert.equal(resolveReleasedPbqAnswer(terminal.presentation, { executedCommands: ['opaque-command-id'] }, { questionType: terminal.type }).status, 'invalid');
const ordering = fixtures.find(({ type }) => type === 'pbq-ordering');
assert.equal(resolveReleasedPbqAnswer(ordering.presentation, { selectedOrder: 'order-one' }, { questionType: ordering.type }).status, 'invalid');

assert.equal(resolveReleasedPbqAnswer({ assets: { siemEvents: [] } }, {}, { questionType: 'pbq-siem' }).status, 'not-applicable');
assert.equal(resolveReleasedPbqAnswer({}, {}, { questionType: 'single-choice' }).status, 'not-applicable');

const component = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewAnswer.jsx', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
const edgeTests = fs.readFileSync(new URL('../supabase/functions/certsim-protected-exam/tests/function_test.ts', import.meta.url), 'utf8');
const pdf = fs.readFileSync(new URL('../src/lib/savedResultReportExport.js', import.meta.url), 'utf8');
for (const componentName of [
  'PBQExamQuestion', 'SimulatedTerminal', 'MultiHostTerminalLab', 'FirewallRuleSimulator',
  'SIEMLogViewer', 'NetworkDiagramLab', 'ConfigPanelLab', 'EvidenceSelectionLab',
  'PBQMatchingLab', 'PBQOrderingLab', 'WorkspacePBQLab', 'InteractiveTopologyLab',
  'InteractiveInvestigationLab', 'PracticalPBQLab',
]) {
  assert.ok(fs.existsSync(new URL(`../src/components/pbq/${componentName}.jsx`, import.meta.url)), componentName);
}
assert.match(component, /resolveReleasedPbqAnswer/);
assert.match(component, /ReleasedPbqAnswer/);
assert.match(component, /No response required/);
assert.doesNotMatch(component, /JSON\.stringify/);
assert.match(edge, /sanitizeReleasedCorrectAnswer/);
assert.match(edge, /sanitizeReleasedPbqResponse/);
assert.match(edge, /PBQ_REVIEW_STRATEGIES/);
assert.match(edgeTests, /strips weighted rubric fields at the Edge boundary/);
assert.match(edgeTests, /exact-whole-state PBQ becomes content-free unavailable markers/);
assert.match(edgeTests, /preserves positive-map and ordered strategy DTOs/);
assert.match(edgeTests, /withheld PBQ review remains unavailable/);
assert.match(pdf, /contains no question text, learner answers, correct answers/);
assert.doesNotMatch(pdf, /resolveReleasedPbqAnswer|ReleasedPbqAnswer/);

console.log('Issue #155 readable released PBQ review validated.');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
