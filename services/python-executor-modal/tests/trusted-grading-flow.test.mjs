import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXECUTION_RESULT_VERSION,
  createSignedExecutionEnvelope,
} from '../../python-executor/src/contract.mjs';
import {
  GRADING_EVIDENCE_VERSION,
  assertAuthenticatedGradingEvidenceForExecution,
  createExecutionResultDigest,
  createGradingBinding,
  createSignedGradingEvidenceEnvelope,
} from '../../python-grading/src/contract.mjs';
import {
  createServerExecutionRequest,
  executeAuthenticatedRequest,
  executeTrustedPythonGradingRequest,
  runTrustedExecutionAndGrading,
} from '../src/index.mjs';
import {
  TRUSTED_GRADING_CONTRACT_VERSION,
  createTrustedGradingMaterialDigest,
} from '../../python-grading/src/trusted-grading-contract.mjs';

const SECRET = 'synthetic-grading-secret-material-only-0001';
const EXECUTION_SECRET = 'synthetic-execution-secret-material-00001';

const request = createServerExecutionRequest({
  runtime: { language: 'python', contract: 'python-source-v1' },
  workspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'print(42)\n' }] },
  limits: { wallTimeMs: 1_000, memoryBytes: 64 * 1024 * 1024, outputBytes: 8_192 },
}, { idFactory: () => '00000000-0000-4000-8000-000000000001' });
const result = {
  contractVersion: EXECUTION_RESULT_VERSION,
  executionId: 'execution.synthetic-flow-001',
  status: 'finished',
  stdout: '42\n',
  stderr: '',
  exitCode: 0,
  outcome: 'completed',
  diagnostics: [],
};
const binding = createGradingBinding({
  gradingSessionId: 'grading-session.synthetic-flow-001',
  request,
  materializationId: 'materialization.synthetic-flow-001',
  materialDigest: 'a'.repeat(64),
  gradingContractVersion: 'python-grading.synthetic-v1',
  maximumRawPoints: 5,
});

test('R2 request identity is generated inside the trusted service boundary', () => {
  assert.equal(request.requestId, 'request.00000000-0000-4000-8000-000000000001');
  assert.deepEqual(Object.keys(request).sort(), ['contractVersion', 'limits', 'requestId', 'runtime', 'workspace']);
  assert.throws(() => createServerExecutionRequest({
    runtime: request.runtime,
    workspace: request.workspace,
    limits: request.limits,
    learnerId: 'prohibited',
  }));
});

test('an invalid R2 envelope is rejected before the provider runs', async () => {
  let executed = false;
  const provider = {
    async execute() { executed = true; return result; },
    async getStatus() { return result; },
    async cancel() {},
    async dispose() {},
  };
  const envelope = createSignedExecutionEnvelope(request, EXECUTION_SECRET);
  await assert.rejects(() => executeAuthenticatedRequest({
    provider,
    request: { ...request, workspace: { ...request.workspace, files: [{ path: 'main.py', content: 'print(41)\n' }] } },
    envelope,
    signingSecret: EXECUTION_SECRET,
  }), { code: 'REQUEST_AUTHENTICATION_FAILED' });
  assert.equal(executed, false);
});

test('trusted flow grades only a terminal normalized result, verifies evidence, then persists and scores', async () => {
  const events = [];
  const provider = {
    async execute(received) { events.push('execute'); assert.deepEqual(received, request); return result; },
    async getStatus() { throw new Error('terminal result must not be polled'); },
    async cancel() {},
    async dispose() {},
  };
  const output = await runTrustedExecutionAndGrading({
    provider,
    request,
    binding,
    executionEnvelope: createSignedExecutionEnvelope(request, EXECUTION_SECRET),
    executionSigningSecret: EXECUTION_SECRET,
    gradingSecret: SECRET,
    runId: '00000000-0000-4000-8000-000000000086',
    grade: async ({ request: receivedRequest, executionResult, binding: receivedBinding }) => {
      events.push('grade');
      assert.deepEqual(receivedRequest, request);
      assert.deepEqual(executionResult, result);
      const evidence = {
        evidenceVersion: GRADING_EVIDENCE_VERSION,
        evidenceId: 'evidence.synthetic-flow-001',
        gradingSessionId: receivedBinding.gradingSessionId,
        requestId: receivedBinding.requestId,
        requestDigest: receivedBinding.requestDigest,
        executionId: executionResult.executionId,
        executionResultDigest: createExecutionResultDigest(executionResult, { outputByteLimit: request.limits.outputBytes }),
        materializationId: receivedBinding.materializationId,
        materialDigest: receivedBinding.materialDigest,
        gradingContractVersion: receivedBinding.gradingContractVersion,
        earnedRawPoints: 3,
        maximumRawPoints: 5,
        rules: [
          { ruleId: 'rule.synthetic-a', earnedRawPoints: 2, maximumRawPoints: 2 },
          { ruleId: 'rule.synthetic-b', earnedRawPoints: 1, maximumRawPoints: 3 },
        ],
      };
      return { evidence, envelope: createSignedGradingEvidenceEnvelope(evidence, SECRET) };
    },
    persistVerifiedEvidence: async (record) => {
      events.push('persist');
      assert.equal(record.earnedRawPoints, 3);
      assert.equal(record.runId, '00000000-0000-4000-8000-000000000086');
      assert.equal('secret' in record, false);
      assert.equal('envelope' in record, false);
      return { persisted: true };
    },
    applyGenericScore: async (raw) => {
      events.push('score');
      assert.equal(raw.earnedRawPoints, 3);
      return { acceptedByGenericScorer: true };
    },
  });
  assert.deepEqual(events, ['execute', 'grade', 'persist', 'score']);
  assert.deepEqual(output.persisted, { persisted: true });
  assert.deepEqual(output.score, { acceptedByGenericScorer: true });
});

test('invalid evidence is rejected before persistence or scoring', async () => {
  let persisted = false;
  let scored = false;
  await assert.rejects(() => runTrustedExecutionAndGrading({
    provider: {
      async execute() { return result; },
      async getStatus() { return result; },
      async cancel() {},
      async dispose() {},
    },
    request,
    binding,
    executionEnvelope: createSignedExecutionEnvelope(request, EXECUTION_SECRET),
    executionSigningSecret: EXECUTION_SECRET,
    gradingSecret: SECRET,
    runId: '00000000-0000-4000-8000-000000000086',
    grade: async () => ({ evidence: {}, envelope: {} }),
    persistVerifiedEvidence: async () => { persisted = true; },
    applyGenericScore: async () => { scored = true; },
  }));
  assert.equal(persisted, false);
  assert.equal(scored, false);
});

test('private grading operation builds and verifies R4 evidence with a distinct grading key', async () => {
  const events = [];
  const material = {
    contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
    taskId: 'synthetic-private-grade',
    maximumRawPoints: 1,
    rules: [{
      id: 'rule.synthetic-structure',
      type: 'AST',
      points: 1,
      compiled: {
        contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
        family: 'ast_features',
        requiredNodes: [{ type: 'Call', minimum: 1 }],
        requiredCalls: ['print'],
        requiredNames: [],
        requiredDefinitions: [],
        requiredAttributes: [],
        requiredLiterals: [],
        requiredOperators: [],
        forbiddenCalls: [],
        forbiddenAttributes: [],
        orderedNames: [],
        requireDynamicReturn: false,
      },
    }],
  };
  const trustedBinding = createGradingBinding({
    gradingSessionId: 'grading-session.synthetic-private-001',
    request,
    materializationId: 'materialization.synthetic-private-001',
    materialDigest: createTrustedGradingMaterialDigest(material),
    gradingContractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
    maximumRawPoints: 1,
  });
  const provider = {
    async execute(received) { events.push('execute'); assert.deepEqual(received, request); return result; },
    async getStatus() { throw new Error('terminal result must not be polled'); },
    async cancel() {},
    async dispose(received) { events.push('dispose'); assert.equal(received, result.executionId); return result; },
    async close() { events.push('close'); },
  };
  const graded = await executeTrustedPythonGradingRequest({
    provider,
    request,
    binding: trustedBinding,
    executionEnvelope: createSignedExecutionEnvelope(request, EXECUTION_SECRET),
    executionSigningSecret: EXECUTION_SECRET,
    gradingSecret: SECRET,
    material,
    idFactory: () => '00000000-0000-4000-8000-000000000002',
  });
  assert.deepEqual(events, ['execute', 'dispose', 'close']);
  assert.equal(graded.evidence.earnedRawPoints, 1);
  assert.deepEqual(graded.evidence.rules, [{
    ruleId: 'rule.synthetic-structure', earnedRawPoints: 1, maximumRawPoints: 1,
  }]);
  assertAuthenticatedGradingEvidenceForExecution({
    request,
    executionResult: graded.executionResult,
    binding: trustedBinding,
    evidence: graded.evidence,
    envelope: graded.envelope,
    secret: SECRET,
  });
});
